# 从 Harness 视角理解 DKAgent

## 1. 先看整体：DKAgent 是什么系统

DKAgent 不是“System Prompt + 一次模型调用”，而是一套围绕模型构建的最小 Agent Harness。模型负责语义判断和选择下一步；Harness 负责组装依赖、控制循环、暴露能力、执行工具、维持协议、限制循环、记录过程并把结果交回模型。

当前系统的最短主链是：

```text
用户输入
→ CLI 组合根创建 Agent
→ AgentLoop 组织一次 Turn 和多个 Step
→ QueryEngine 调用模型
→ 模型返回最终文本：结束
→ 模型返回 Tool Call：Dispatcher 执行能力
→ Tool Result 原样关联 toolCallId 回传模型
→ 继续下一 Step，直到完成或超过 maxSteps
```

从 Harness 角度，模型只是一个“不确定的决策组件”。真正让它成为 Agent 的，是模型外部这几层：

1. **控制层**：AgentLoop 决定什么时候调用模型、工具和停止。
2. **模型协议层**：QueryEngine 与 Provider 隔离厂商协议和流式细节。
3. **能力层**：ToolRegistry、Dispatcher、Tool 和 Skill 提供可执行动作。
4. **业务层**：面试分析流水线把多个小能力编排成领域结果。
5. **观测层**：Trace 和 Web Tap 解释 Agent 实际做了什么。

配套流程图：[DKAgent Harness 主流程图](./2026-08-18-dkagent-harness-flow.drawio)。按要求，图中不包含 Context、Memory、Session；本文也不展开它们，只承认 CLI 和 AgentLoop 当前会使用这些依赖。

## 2. 一次真实 Turn 如何运行

### 2.1 启动阶段

`packages/agent/src/index.ts` 只负责启动 CLI。真正的组合根是 `packages/agent/src/cli/run.ts`：它读取配置，创建 Provider、QueryEngine、ToolRegistry、Tracer 等对象，再把这些依赖注入 AgentLoop。

组合根的价值是把“对象怎么创建”集中在边缘。AgentLoop 只依赖抽象和配置，不需要自己读取环境变量或实例化 OpenAI SDK。没有这层，核心逻辑会与数据库、SDK、终端和观测界面耦合，测试很难替换依赖。

### 2.2 决策循环

用户输入进入 `AgentLoop.run()` 后形成一个 Turn。每次循环是一个 Step，默认最多 4 步，CLI 当前显式配置为 5 步。

每个 Step 的核心判断只有两个分支：

```text
ModelResponse.type === "text"
  → 保存最终回答并结束

ModelResponse.type === "tool_use"
  → 保存 Assistant Tool Call
  → 串行执行所有 Tool Call
  → 保存 Tool Result
  → 下一 Step 再问模型
```

`maxSteps` 是最小防失控机制。没有它，模型反复调用能力时可能形成无限循环。当前未实现重复 Tool Call 检测和基于成本的终止策略，这是后续 Harness 加固点。

### 2.3 Tool 往返为什么必须保留 ID

模型返回的每个 Tool Call 都带 `id`。Dispatcher 执行后，AgentLoop 用相同 `toolCallId` 生成 Tool Result。这个关联使下一次模型请求能知道“哪一个调用对应哪一个结果”。

如果丢失或改写 ID，模型协议链会损坏；多 Tool Call 场景尤其容易把结果配错。DKAgent 的 `ToolCall`、`AgentMessage` 和流解析器都把这个 ID 当成稳定协议字段。

## 3. System Prompt：模型侧的稳定行为契约

路径：`packages/agent/src/agent/prompt.ts`

### 为什么需要

Tool Schema 只能告诉模型“有什么能力”，不能完整表达 Agent 的身份、目标、证据边界和授权原则。System Prompt 为每个 Turn 提供稳定的决策方向。

### 负责什么

- DKAgent 是面试成长 Agent；
- 围绕用户目标推进，必要时才暂停询问；
- 区分通用知识、用户事实、动态事实、推断和不确定信息；
- 根据运行时能力元数据决定直接回答还是调用能力；
- 对写入、删除、外发、付费和高风险操作要求确认；
- 能力失败或缺失时不得假装执行成功。

### 不负责什么

System Prompt 不是权限拦截器、参数校验器或业务状态机。它可以要求模型先确认，但不能阻止模型发出一个危险 Tool Call。确定性安全必须由 Harness 在执行前校验。

### 当前现状

**已实现**：稳定 Prompt 已注入 AgentLoop，且静态测试确保其不再枚举 `find_files`、`analyze_interview`。

**未实现**：Prompt 提到“运行时能力元数据”和“Harness 权限判断”，但当前通用 Tool Schema 只有 `name`、`description`、`parameters`；统一风险等级、审批规则和 Permission Gate 尚未落地。

## 4. AgentLoop：Harness 的控制中枢

路径：`packages/agent/src/agent/loop.ts`

### 为什么需要

普通聊天程序只调用一次模型；Agent 需要根据模型响应反复执行“模型 → 工具 → 模型”。AgentLoop 把这个非确定过程约束成有限状态循环。

### 核心职责

1. 接收用户输入并创建 Turn Trace。
2. 在每个 Step 组装模型请求。
3. 调用 QueryEngine，识别文本或 Tool Use。
4. 保存 Assistant Tool Call 和对应 Tool Result。
5. 串行执行同轮多个 Tool Call。
6. 处理 Abort、空文本和最大步数。
7. 将关键操作送入 Tracer。

### 没有它会怎样

调用方需要手写循环、消息追加、Tool Result 关联和停止条件。相同规则会散落在 CLI、业务 Tool 和模型适配器中，无法统一测试。

### 当前限制

- 同轮 Tool Call 强制串行；Provider 也设置 `parallel_tool_calls: false`。
- 没有重复调用检测、总成本预算和通用重试策略。
- 权限只存在于 Prompt 原则和个别 Tool 错误码中，没有执行前的统一 Gate。

## 5. QueryEngine 与 Provider：模型协议隔离层

路径：

- `packages/agent/src/query-engine/query-engine.ts`
- `packages/agent/src/query-engine/provider.ts`
- `packages/agent/src/query-engine/stream-parser.ts`
- `packages/agent/src/query-engine/providers/openai-compatible.ts`

### 为什么需要

AgentLoop 不应该理解 OpenAI Chunk、SDK 类型或 `finish_reason`。模型协议层把厂商响应转换为 DKAgent 自己的稳定协议。

### 分工

- `provider.ts`：定义 `ModelRequest`、`ModelResponse`、消息、Tool Schema、流事件和 Token Usage。
- `OpenAICompatibleProvider`：把内部协议转换为 OpenAI Chat Completions 请求，再把 Chunk 转为中立事件。
- `stream-parser.ts`：校验事件顺序，拼接文本和 Tool 参数，最终输出 `text` 或 `tool_use`。
- `QueryEngine`：保持极薄，只负责调用 Provider Stream 并聚合结果。

### 协议保护

流解析器会拒绝重复 Start、缺少 End、重复 Message End、非法 JSON Tool 参数等损坏协议。这类校验必须在 Harness 内完成，不能要求模型自觉修复。

### 当前限制

接口是 Provider 中立的，但当前实际实现只有 OpenAI-Compatible Provider。`countTokens()` 使用 UTF-8 字节数除以 4 的近似值，不是官方 tokenizer 精确结果。

## 6. ToolRegistry 与 Dispatcher：能力注册和执行边界

路径：

- `packages/agent/src/tools/types.ts`
- `packages/agent/src/tools/registry.ts`
- `packages/agent/src/agent/dispatcher.ts`
- `packages/agent/src/tools/index.ts`

### 为什么需要

模型只能输出“想调用哪个能力和参数”，不能直接执行 Node.js 函数。Registry 保存可调用实现并向模型暴露 Schema；Dispatcher 把模型的 Tool Call 映射为真实执行。

### ToolRegistry 职责

- 注册 Tool，并拒绝重名；
- 按名称解析真实 Tool；
- 导出模型可见的 `name + description + parameters`；
- 提供列表和存在性判断。

### Dispatcher 职责

- 根据名称找到 Tool；
- 传入 QueryEngine 和 AbortSignal；
- 将抛出的异常包装成统一 `ToolResult`；
- 保留原始 `toolCallId`。

### 当前注册能力

- `read_file`、`find_files`、`grep_files`、`write_file`；
- 对外的面试分析 Tool `analyze_interview`。

### 重要边界

当前 `ToolResult` 已有 `input_error`、`service_error`、`timeout`、`permission_denied` 错误类型，但 Dispatcher 会把所有未捕获异常统一包装为 `input_error`。这会损失错误语义，后续应由 Tool 或统一错误映射保留真实分类。

## 7. Skill 与面试分析：业务编排层

路径：

- `packages/agent/src/skills/diagnose-transcript.ts`
- `packages/agent/src/tools/tool-item/analyze-interview.ts`
- `packages/agent/src/interview/`
- `packages/agent/src/tools/tool-item/`

### Tool 和 Skill 的区别

Tool 是模型可直接调用的原子接口；Skill 是多个能力组成的任务级编排。当前 `diagnose-transcript` Skill 不直接暴露给主模型，而是被 `analyze_interview` Tool 包装。

这层包装有两个价值：

1. 主模型只需理解一个稳定的“分析面试”能力，不需要编排十几个内部步骤。
2. 业务流程由 TypeScript 决定，避免主模型漏步骤、乱序或把中间结果当成最终结果。

### 实际流水线

```text
读取面试稿
→ 解析角色轮次
→ 预处理明显转写错误
→ 结构化问题和问题簇
→ 提取项目事实
→ 分析表达
→ 按题型分析每道回答
→ 纯代码评分
→ 生成结构化报告和 Markdown
→ 写入时间戳报告文件
```

### 失败策略

部分步骤允许降级，例如项目事实或表达分析失败后继续处理；报告生成等关键步骤失败则整个 Skill 返回 `service_error`。最终结果包含报告路径、总分、分析数量、待确认数量和 JD 匹配状态。

### 当前限制

这个 Skill 是项目内 TypeScript 编排，还不是可动态发现、安装和解释元数据的通用 Skill Runtime。把它称为“已经支持任意 Skill”是不准确的。

## 8. Knowledge：面试分析的可选参考能力

路径：

- `packages/agent/src/knowledge/`
- `packages/agent/src/skills/knowledge-reference-retriever.ts`

### 为什么需要

知识题诊断不能总靠模型参数知识。Knowledge 模块把本地知识条目变成可检索参考资料，供逐题分析使用。

### 当前职责

- 解析和构建本地知识库；
- SQLite 存储；
- FTS、Embedding 和 RRF 混合检索；
- 通过 `InterviewReferenceRetriever` 转成 Skill 可用的参考文本。

### 与 Harness 的关系

Knowledge 不是主模型可见 Tool。CLI 只有在配置的数据库文件存在时才创建 Retriever，并注入面试 Skill。知识库不可用时，面试流程仍能运行，但知识题缺少参考资料，相关结论置信度应受限制。

### 当前限制

Agent 路径中的 `createKnowledgeReferenceRetriever()` 明确使用 FTS，并取前 3 条结果；CLI 没有注入 Embedding Provider，因此当前 Agent 并未启用向量或 hybrid 检索。若未来切换到 embedding/hybrid，必须先注入 Embedding Provider。

## 9. Trace：旁路可观测性

路径：`packages/trace/src/`

### 为什么需要

Agent 的结果可能正确，但过程可能出现误调用、重复调用、协议错误或成本浪费。只看最终答案无法调试 Harness。

### 核心职责

- 为 Turn、Step、模型请求和 Tool 调用建立 Trace/Span 层级；
- 自动记录 start、event、end、error、耗时和 sequence；
- 使用 AsyncLocalStorage 传播 traceId、spanId 和 step；
- 脱敏 API Key、Authorization、Header、环境变量和召回记忆；
- 隔离 Sink/订阅者异常，保证观测失败不影响 Agent。

### 存储现状

当前 `MemoryTraceStore` 是有界的进程内 Trace Store，默认最多 2000 条事件，重启后清空。这里的 “Memory” 指内存数据结构，不是 DKAgent 的用户记忆模块。

### 没有它会怎样

无法回答“模型看到了什么、为什么调用 Tool、哪个 Step 失败、耗时在哪里”，Prompt 和 Harness 优化会退化为猜测。

## 10. Web Tap：Harness 的只读观察界面

路径：`packages/web-tap/src/`

### 为什么需要

原始 Trace JSON 适合机器，不适合人快速理解。Web Tap 把事件投影为 Session、Turn、Step、Node，并提供时间线、详情和指标视图。

### 数据链路

```text
Tracer
→ TraceStore
→ HTTP 历史快照 + SSE 实时事件
→ Zustand Store 合并
→ React/Ant Design Viewer 展示
```

### 设计原则

- Web Tap 依赖 Agent/Trace，Agent Core 不依赖 Web Tap；
- 只读观察，不能修改 Tool Result 或 Agent 状态；
- Web 服务失败时降级为 Agent-only；
- 前端负责中文展示和派生视图，底层事件保持英文技术协议。

### 当前现状

Web Tap 已使用 React、Ant Design、Zustand、Vite，不再是早期设计稿中的单文件原生 HTML。学习架构时应以当前源码为准。

## 11. Config 与组合根：部署策略和依赖装配

路径：

- `packages/agent/src/config.ts`
- `packages/agent/src/cli/run.ts`
- `packages/web-tap/src/observe.ts`

### Config 负责

读取 API Key、模型、Base URL、输入输出 Token 预算、摘要模型和知识库路径，并对整数和预算关系做确定性校验。

### 组合根负责

决定实际使用哪个 Provider、注册哪些 Tool、是否启用 Knowledge、是否注入 Tracer，以及如何启动 CLI 或 Observe 模式。

组合根不应该包含面试评分规则；业务规则应留在 Interview/Skill 层。反过来，AgentLoop 也不应该读取环境变量或启动 HTTP 服务。

## 12. 当前 Harness 成熟度

| 能力 | 状态 | 证据或说明 |
| --- | --- | --- |
| 有限 Agent Loop | 已实现 | maxSteps、Abort、文本/Tool 分支 |
| Tool Call/Result 协议 | 已实现 | toolCallId 保留、流协议校验 |
| Tool Registry/Dispatcher | 已实现 | 注册、Schema、解析、执行 |
| OpenAI-Compatible Provider | 已实现 | 流式文本和 Tool Calling |
| 面试分析 Skill 编排 | 已实现 | Tool 包装的 TypeScript 工作流 |
| 结构化 Trace 与 Web Tap | 已实现 | 旁路、脱敏、历史 + SSE 展示 |
| Capability Metadata | 设计中 | 当前只有名称、描述、参数 |
| 统一 Permission Gate | 未实现 | Prompt 有原则，代码无统一拦截层 |
| 动态 MCP 发现与治理 | 未实现 | 当前源码无 MCP Runtime |
| 通用 Skill Runtime | 未实现 | 当前只有项目内固定 Skill 编排 |
| 重试、去重、成本预算 | 未实现 | 只有最大步数和 Abort |
| 真实模型 Harness Eval | 不确定 | 当前证据主要是 FakeProvider 和静态测试 |

## 13. 推荐的学习顺序

只沿一条主线学习，不同时钻入所有模块：

1. 从 `cli/run.ts` 看对象如何装配。
2. 跟一遍 `AgentLoop.run()` 的 text 分支。
3. 跟一遍 tool_use 分支，确认 toolCallId 往返。
4. 看 QueryEngine 如何把 Provider Stream 变成统一响应。
5. 看 Registry/Dispatcher 如何把模型意图变成函数执行。
6. 最后看 `analyze_interview → diagnose-transcript`，理解原子 Tool 与任务级 Skill 的区别。
7. 用 Web Tap 对照一次真实 Trace，验证你理解的调用顺序。

完成标准不是“读完所有文件”，而是能够不看代码画出以下主线，并解释每层为什么不能合并：

```text
CLI → AgentLoop → QueryEngine → Provider → Model
                  ↓ tool_use
             Dispatcher → Tool/Skill → Tool Result → AgentLoop
                  ↓ events
               Trace → Web Tap
```

## 14. 本文明确不展开的模块

按本次范围，Context、Memory、Session 不进入流程图，也不做模块教学。它们在当前源码中真实存在，并参与 AgentLoop 与 CLI；本文仅在必要处标明依赖边界，避免读者误以为系统没有这些模块。
