# 最小 Agent Loop 设计

## 目标

在现有 `hello-XxkAgent` 代码上，以最小改动跑通一次真实 OpenAI Tool Calling 循环：

1. CLI 接收面试文字稿。
2. OpenAI 决定调用 `split_qa_pairs`。
3. 本地执行工具。
4. 使用原 `toolCallId` 把结果回传模型。
5. 模型基于工具结果输出最终文字。

第一阶段重点是看清 Agent Loop 如何运转和如何出错，不追求完整、健壮的 Harness。

## 当前断点

- `src/agent/loop.ts` 仍是依赖未定义对象的伪代码。
- `src/agent/dispatcher.ts` 为空。
- `src/tools/index.ts` 没有注册任何工具。
- OpenAI Provider 尚未完整转换普通消息、Assistant Tool Call 和 Tool Result。
- 项目缺少可运行的 `src/index.ts` 入口。
- 全量 TypeScript 检查受未完成的知识库、语音和报告模块影响。

## 第一阶段范围

只接入：

- OpenAI Provider
- Agent Loop
- Tool Registry
- Dispatcher
- `split_qa_pairs`
- CLI 入口

暂不接入：

- 知识库
- `analyze_content`
- `generate_report`
- 语音分析
- Memory、Permission、Hook、Sub-agent
- Web UI 和 SSE
- 统一 Runtime Schema 校验
- 重试、缓存和重复调用检测

## 核心调用链

```text
CLI 输入文字稿
  -> 创建内存 AgentRun
  -> QueryEngine 调用 OpenAI
  -> OpenAI 返回 tool_call
  -> Agent Loop 保存 Assistant Tool Call
  -> Dispatcher 执行 split_qa_pairs
  -> Agent Loop 保存带 toolCallId 的 Tool Result
  -> 再次调用 OpenAI
  -> OpenAI 返回最终文本
  -> CLI 输出结果
```

## 最小数据结构

```ts
interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

interface AgentRun {
  input: string;
  messages: AgentMessage[];
  step: number;
  maxSteps: number;
  abortSignal: AbortSignal;
}
```

不引入 Zod。第一版继续使用已有 JSON Schema 描述工具参数，并由具体 Tool 自行检查输入。

## 模块职责

- `src/query-engine/provider.ts`：统一 Message、ToolSchema、ToolCall 和模型返回类型。
- `src/query-engine/providers/openai.ts`：在内部协议和 OpenAI SDK 类型之间转换。
- `src/query-engine/stream.ts`：聚合流式文本和 Tool Call 参数。
- `src/agent/loop.ts`：控制模型调用、工具执行、结果回传和终止。
- `src/agent/dispatcher.ts`：按名称查找并执行 Tool，将异常包装为可回传结果。
- `src/tools/registry.ts`：保存 Tool 并导出 Tool Schema。
- `src/tools/index.ts`：第一阶段只注册 `split_qa_pairs`。
- `src/index.ts`：加载配置、组装依赖、接收输入并启动 Agent Loop。

## Agent Loop 规则

1. 每次模型调用计为一步。
2. 有 Tool Call 时，保存 Assistant Tool Call，执行工具并保存对应 Tool Result，然后继续循环。
3. 没有 Tool Call 且存在最终文本时结束。
4. 同轮多个 Tool Call 暂时串行执行。
5. 超过 `maxSteps` 时抛出明确错误。
6. Tool 不存在或执行失败时，把错误作为 Tool Result 回传模型。
7. 网络、鉴权和流解析错误第一版直接终止。

## 已知脆弱点

第一版有意保留以下问题，后续用实际故障驱动加固：

- `JSON.parse` 遇到非法 Tool 参数会导致整轮失败。
- 没有统一参数校验。
- 模型可能重复调用同一工具。
- Tool Result 没有完整错误分类。
- 没有 Session 持久化和执行审计。
- 没有 Mock Provider 和自动化回归测试。

## 完成标准

使用一份带角色标签的面试文字稿运行 CLI，并得到可观察证据：

1. 日志显示 OpenAI 请求开始。
2. 日志显示模型调用 `split_qa_pairs`。
3. 日志显示工具成功返回 Q&A 数组。
4. 第二次模型请求包含匹配的 `toolCallId` 和 Tool Result。
5. 模型输出基于拆分结果生成的最终文字。

只满足以上五项，才算第一条 Agent Loop 跑通。全量 TypeScript 检查、知识库和完整诊断报告不属于本里程碑。

## 后续加固顺序

1. 接入 `analyze_content`。
2. 接入 `generate_report`。
3. 增加统一参数校验。
4. 增加错误分类和模型纠错反馈。
5. 增加重复调用检测与最大步数测试。
6. 增加 Abort、事件日志和 Mock Provider。
7. 再引入 Session、Hook、Permission、知识库和 Sub-agent。
