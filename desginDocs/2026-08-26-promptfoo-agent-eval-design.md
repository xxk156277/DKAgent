# Promptfoo Agent Tool Calling 测评设计

## 1. 目标

为 DKAgent 增加一个完全本地保存测评数据的 Agent Tool Calling 测评入口。Promptfoo 通过自定义 TypeScript Provider 直接运行真实 `AgentLoop`，再使用 DKAgent 现有 `TraceEvent[]` 与临时工作区的最终文件状态判断 Agent 是否正确完成任务。

本次只覆盖通用文件 Tool，按三个可独立验收的里程碑逐层增加能力：

1. M1：跑通 `read_file` 的完整测评闭环。
2. M2：增加无需 Tool、`find_files` 和 `grep_files`。
3. M3：增加 `read_file → write_file` 多步调用与最终文件状态验证。

本设计不评价面试分析业务，也不建立通用测评平台。

## 2. 已确认约束

- 测评对象是 Tool Calling / AgentLoop，不是面试业务输入输出。
- Promptfoo 配置、Case、Trace 副本、结果和报告只保存在本机。
- DKAgent 与测评目标使用现有远程模型配置；数据不会同步到 Promptfoo Cloud。
- 第一阶段通过本地 `npm run eval:agent` 手动运行；DKAgent 当前没有 CI，本次不新增 CI。
- 每个 Case 使用独立临时工作区，文件 Tool 的 `cwd` 只能指向该目录。
- 测评使用生产 `AgentLoop`、QueryEngine、Provider、System Prompt、Trace 与文件 Tool 实现。
- Session、Memory、Context 压缩、面试 Skill 和面试 Tool 不进入本次测评，避免混入其他能力变量。
- 现有设计文档和当前源码对公共 ToolRegistry 的描述存在差异；实现以当前检出源码为事实，Eval 入口显式构建仅包含本次文件 Tool 的 Registry。

## 3. 核心关系

Case、Trace 与文件状态分别回答不同问题，不重复建模：

```text
Case expectation：应该发生什么
TraceEvent[]：实际发生了什么
Workspace State：任务实际上是否完成
Promptfoo：比较预期与实际并报告失败原因
```

DKAgent Trace 继续是唯一执行过程事实源。测评代码不新增第二套 Trace 事件模型，不修改 `TraceSink`，也不依赖 Web Tap。

## 4. 总体架构

```text
Promptfoo Case
  → 自定义 DKAgent TypeScript Provider
  → 创建 Case 临时工作区并复制 Fixture
  → 组装真实 QueryEngine、AgentLoop、文件 ToolRegistry 和 MemoryTraceStore
  → 调用远程真实模型完成任务
  → 收集 answer、TraceEvent[] 和必要的最终文件状态
  → 清理临时工作区
  → 自定义 Assertions 比较预期与实际
  → 结果写入本地 .dkagent/promptfoo/
```

### 4.1 Promptfoo

负责加载五个固定 Case、调用 Provider、运行断言、展示结果和设置命令退出码。Promptfoo 不负责定义 DKAgent Trace，也不直接执行文件 Tool。

### 4.2 DKAgent Provider

负责把 Promptfoo 的单个输入转换为一次隔离的 `AgentLoop.run()`：

- 读取 Case ID 与用户输入；
- 创建临时目录并复制对应 Fixture；
- 创建只含当前里程碑所需文件 Tool 的 Registry；
- 创建真实 QueryEngine、ContextManager、AgentLoop、Tracer 和 MemoryTraceStore；
- 禁用 Session、Memory 和 Context 压缩；
- 使用与当前 CLI 一致的 `maxSteps: 12`；
- 返回最终回答、脱敏后的原始 `TraceEvent[]` 与 M3 需要的文件状态。

Provider 不接收或读取 Case 的 expectation，保证预期行为不会进入模型 Prompt。

### 4.3 Trace Selectors

测评层只提供读取现有 `TraceEvent[]` 的纯函数，例如：

```ts
selectToolCalls(events);
selectToolResults(events);
countAgentSteps(events);
findUnpairedToolCalls(events);
```

Selector 不定义新的持久化 Trace Schema，不修改事件，不写入生产 Store。

### 4.4 Assertions

自定义 JavaScript/TypeScript Assertion 读取 `ProviderResponse.metadata` 中的原始 Trace 与最终文件状态，返回带 `componentResults` 的确定性评分。每个组件明确说明通过或失败原因。

LLM Judge 不参与本次 Tool Calling 核心判断。

## 5. 目录设计

```text
evals/agent-loop/
├── promptfooconfig.ts
├── provider.ts
├── assertions.ts
├── trace-selectors.ts
├── assertions.test.ts
└── fixtures/
    ├── read-file/
    │   └── notes.txt
    ├── find-files/
    │   ├── src/a.ts
    │   ├── src/b.ts
    │   └── README.md
    ├── grep-files/
    │   ├── hit.txt
    │   └── miss.txt
    └── read-then-write/
        └── source.txt
```

为保持 MVP 简单，本次不创建通用 Case SDK、数据库或多层 Runner 抽象。五个 Case 直接由 TypeScript Promptfoo 配置声明。

## 6. Provider 输出

Provider 复用 `@dkagent/trace` 的 `TraceEvent`，只增加测评运行所必需的外部结果：

```ts
interface AgentEvalRunMetadata {
  caseId: string;
  traceEvents: TraceEvent[];
  runError?: {
    stage: "setup" | "model" | "agent" | "cleanup";
    message: string;
  };
  finalFiles?: Record<string, string>;
}
```

Promptfoo ProviderResponse：

```ts
{
  output: answer,
  metadata: {
    evalRun: AgentEvalRunMetadata
  }
}
```

`finalFiles` 只在 M3 返回需要验证的 `result.txt`，不做通用工作区 before/after Diff。

## 7. Case 矩阵

### 7.1 M1：read_file

Fixture `notes.txt` 包含稳定标记 `DKAGENT_EVAL_7319`。

输入：

```text
请读取 notes.txt，并告诉我其中的验证码。
```

断言：

- 调用了 `read_file`；
- Tool 参数解析后指向临时工作区内的 `notes.txt`；
- Tool Result 成功；
- Tool Call 与 Tool Result 完整配对；
- 最终回答包含 `DKAGENT_EVAL_7319`；
- Agent 正常结束。

### 7.2 M2：no-tool / find_files / grep_files

`no-tool`：要求模型直接回复固定文本 `READY`。断言没有任何 Tool Call，最终回答包含 `READY`，Agent 正常结束。

`find-files`：要求查找 `src` 下的 TypeScript 文件。断言调用 `find_files`，Tool Result 成功，结果集合包含 `src/a.ts` 和 `src/b.ts`，且不包含 `README.md`。

`grep-files`：要求搜索稳定标记。断言调用 `grep_files`，Tool Result 成功，匹配结果包含正确文件与目标文本，不要求模型生成唯一一种等价参数组合。

### 7.3 M3：read_file → write_file

输入要求读取 `source.txt`，将完整内容写入新的 `result.txt`。

断言：

- `read_file` 发生在 `write_file` 之前；
- 两个 Tool Result 都成功且 Call/Result 完整配对；
- `write_file` 的目标解析为临时工作区内的 `result.txt`；
- 清理前真实读取 `result.txt`，内容与 `source.txt` 完全一致；
- Agent 正常结束。

## 8. 测评方法与本次指标

本次不输出没有统计意义的 Precision、Recall 或成功率百分比，只为每个 Case 输出以下 Pass/Fail 组件：

1. Task outcome：回答或最终文件状态是否正确。
2. Tool selection：是否调用所需 Tool，`no-tool` 是否保持零调用。
3. Tool arguments/result：参数是否语义正确，Tool Result 是否成功。
4. Protocol integrity：Tool Call/Result 是否配对。
5. Termination：是否在最大 Step 内正常结束。

参数比较采用语义结果优先原则。例如 `find_files` 的 `path + pattern` 存在多种等价组合时，以 Tool Result 的文件集合为主要证据，避免把有效轨迹误判为失败。

## 9. 失败分类

| 类型 | 例子 | Promptfoo 表现 |
|---|---|---|
| Setup Failure | Fixture 复制或配置加载失败 | Provider Error |
| Model Failure | 远程 API 超时或协议错误 | Run Error，并保留已有 Trace |
| Tool Selection Failure | 选择错误 Tool 或 `no-tool` 发生调用 | Tool 组件失败 |
| Tool Execution Failure | Tool Result 为失败 | Result 组件失败 |
| Protocol Failure | Call 没有对应 Result | Integrity 组件失败 |
| Outcome Failure | 回答缺少标记或 `result.txt` 错误 | Outcome 组件失败 |

失败消息只包含脱敏后的必要诊断，不写入 API Key、环境变量或未脱敏请求头。

## 10. 临时工作区生命周期

每个 Case 都执行：

```text
创建唯一临时目录
→ 复制 Case Fixture
→ 将文件 Tool cwd 绑定到临时目录
→ 运行 Agent 并收集 Trace
→ M3 读取 result.txt
→ 在 finally 中清理临时目录
```

Agent、模型或 Tool 失败时，Provider 先复制已产生的脱敏 Trace 到返回 metadata，再执行清理。清理失败作为独立诊断记录，不能把任务失败伪装为成功。

## 11. 本地数据边界

`npm run eval:agent` 设置：

```text
PROMPTFOO_DISABLE_TELEMETRY=1
PROMPTFOO_DISABLE_UPDATE=1
PROMPTFOO_DISABLE_REMOTE_GENERATION=true
PROMPTFOO_DISABLE_SHARING=1
PROMPTFOO_CONFIG_DIR=.dkagent/promptfoo
```

命令禁用 Promptfoo 缓存，确保每次都真实运行目标模型。`.dkagent/` 已在 `.gitignore` 中，结果不会进入 Git。

这些开关用于关闭常见 Promptfoo 托管功能，但不等同于网络防火墙。按用户确认，DKAgent 配置的远程模型 Provider 是唯一允许承载 Case Prompt 和模型响应的外部服务。

配置文件不得复制 API Key；Provider 只从现有环境和 DKAgent 配置读取凭据。

## 12. 验证与验收

### 12.1 自动验证

- `assertions.test.ts` 使用构造的 `TraceEvent[]` 验证 Selector、Call/Result 配对和 Outcome 判断，防止测评器自身误判。
- 运行 Agent 包聚焦测试和 TypeScript 类型检查，确认接入未破坏现有行为。
- 运行 `git diff --check` 检查补丁格式。

### 12.2 真实验收

按 M1 → M2 → M3 顺序执行 `npm run eval:agent`：

- M1 单 Case 先通过；
- 加入 M2 后累计四个 Case 可执行；
- 加入 M3 后累计五个 Case 可执行；
- Promptfoo 能展示每个 Case 的最终回答、组件断言和具体失败原因；
- 本地结果保存在 `.dkagent/promptfoo/`；
- 未产生 Promptfoo Cloud 分享或同步。

真实模型一次运行通过，只证明当次模型、配置与五个样本的表现，不代表所有模型或重复运行稳定通过。

## 13. 非目标

本次不实现：

- 文件不存在、路径越界、错误参数、未授权写入等错误或安全 Case；
- 重复运行、稳定性统计、Precision/Recall 聚合；
- LLM Judge、Token/成本/延迟门槛；
- OpenTelemetry、Promptfoo 原生 trajectory Trace 或 Web Tap 集成；
- CI、线上评测、Promptfoo Cloud；
- 多模型对比、红队测试；
- 面试业务 Tool、Session、Memory 或 Context 压缩测评。

## 14. 后续叠加顺序

在本设计全部验收后，后续独立设计可依次增加：

```text
错误与越界 Case
→ 写入授权与安全 Case
→ 重复运行和稳定性指标
→ Token、成本与延迟观测
→ 有明确展示需求时再评估 OTLP
```
