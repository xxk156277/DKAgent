# Minimal Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有项目中跑通 `OpenAI -> split_qa_pairs -> Tool Result -> OpenAI 最终文本` 的第一条原生 Tool Calling 循环。

**Architecture:** 保留现有 Provider、QueryEngine、ToolRegistry 和 Tool 的分层，但第一阶段只接 OpenAI 与 `split_qa_pairs`。Agent Loop 保存 Assistant Tool Call，并用同一个 `toolCallId` 回传 Tool Result；知识库、缓存、重试、运行时统一校验暂不进入主链路。

**Tech Stack:** Node.js、TypeScript、OpenAI SDK 6.49、原生 `node:test`、tsx。

## Execution Order Override

用户确认当前阶段采用集成优先：先完成最小 tracer bullet，让现有 Provider、Agent Loop、Dispatcher 与 Tool 真正串联并运行；第一次真实运行后，再围绕实际故障补回归测试。下方测试设计继续保留，作为闭环跑通后的加固清单，不作为开始集成的前置条件。

## Global Constraints

- 不引入 Zod 或其他新的 Runtime Schema 校验库。
- 只注册 `split_qa_pairs`，不接知识库、内容诊断、报告、语音、Memory、Permission、Hook、Sub-agent。
- 第一条验收输入必须是带“面试官：/候选人：”标签的文字稿，避免触发 `splitWithLLM` 的嵌套模型调用。
- 使用现有环境变量 `LLM_API_KEY`、`LLM_MODEL_ID`；`LLM_BASE_URL` 改为可选。
- 不读取或打印 API Key。
- 当前目录不是 Git 仓库，因此每个任务以测试检查点结束，不执行 commit。
- 全量 `npm run typecheck` 仍会暴露尚未接入模块的问题；本里程碑以 `typecheck:phase1` 为准，不宣称全项目通过。

## File Map

- Create `src/config.ts`：第一阶段 OpenAI 配置读取。
- Create `src/agent/run.ts`：一次 Agent Run 的内存状态。
- Create `src/index.ts`：CLI 组合根。
- Create `tsconfig.phase1.json`：只检查第一阶段主链路。
- Create `test/phase1/stream.test.ts`：流事件聚合测试。
- Create `test/phase1/query-engine.test.ts`：QueryEngine 转发测试。
- Create `test/phase1/dispatcher.test.ts`：工具分发测试。
- Create `test/phase1/openai-provider.test.ts`：OpenAI 消息协议转换测试。
- Create `test/phase1/agent-loop.test.ts`：完整 Mock Agent Loop 测试。
- Create `test/phase1/config.test.ts`：配置读取测试。
- Create `test/fixtures/labeled-interview.txt`：真实调用用的最小文字稿。
- Modify `src/query-engine/provider.ts`：统一消息、Tool Call 和流事件协议。
- Modify `src/query-engine/stream.ts`：聚合文本与单个 Tool Call。
- Modify `src/query-engine/queryEngine.ts`：第一阶段最小 QueryEngine。
- Modify `src/query-engine/providers/openai.ts`：OpenAI SDK 适配。
- Modify `src/tools/types.ts`：移除未定义的外部类型依赖。
- Modify `src/tools/registry.ts`：使用类型擦除后的 Tool 保存不同输入类型的工具。
- Modify `src/tools/index.ts`：注册 `split_qa_pairs`。
- Modify `src/tools/tool-item/split.ts`：第一阶段明确拒绝无标签文字稿，移除嵌套模型调用。
- Modify `src/agent/dispatcher.ts`：查找并执行 Tool。
- Modify `src/agent/loop.ts`：实现有限步数 Agent Loop。
- Modify `package.json`：增加第一阶段运行、测试和类型检查命令。

---

### Task 1: 统一 Provider 协议并聚合 Tool Call 流

**Files:**
- Modify: `src/query-engine/provider.ts`
- Modify: `src/query-engine/stream.ts`
- Test: `test/phase1/stream.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `AgentMessage`、`ToolSchema`、`ToolCall`、`StreamParams`、`StreamEvent`、`ParsedResponse`、`parseStream()`。

- [ ] **Step 1: 写流聚合失败测试**

创建 `test/phase1/stream.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { StreamEvent } from "../../src/query-engine/provider.js";
import { parseStream } from "../../src/query-engine/stream.js";

async function* events(): AsyncIterable<StreamEvent> {
  yield { type: "tool_use_start", id: "call_1", name: "split_qa_pairs" };
  yield { type: "tool_use_delta", input: '{"transcript":"面试官：什么是闭包？' };
  yield { type: "tool_use_delta", input: '候选人：闭包保存词法作用域。","format":"labeled"}' };
  yield { type: "tool_use_end" };
  yield {
    type: "message_end",
    usage: { inputTokens: 12, outputTokens: 8 },
    stopReason: "tool_use",
  };
}

test("parseStream aggregates one streamed tool call", async () => {
  const response = await parseStream(events());

  assert.equal(response.type, "tool_use");
  if (response.type !== "tool_use") assert.fail("expected tool_use");

  assert.deepEqual(response.toolCalls, [
    {
      id: "call_1",
      name: "split_qa_pairs",
      input: {
        transcript: "面试官：什么是闭包？候选人：闭包保存词法作用域。",
        format: "labeled",
      },
    },
  ]);
  assert.equal("content" in response, false);
});
```

- [ ] **Step 2: 运行测试并确认协议尚未统一**

Run:

```bash
npx tsx --test test/phase1/stream.test.ts
```

Expected: FAIL，断言显示 `"content" in response` 实际为 `true`。这证明当前实现把缺失内容表示成了 `content: undefined`，尚未形成干净的可判别联合类型。

- [ ] **Step 3: 替换 Provider 公共类型**

将 `src/query-engine/provider.ts` 收敛为：

```ts
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamParams {
  model: string;
  messages: AgentMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; input: string }
  | { type: "tool_use_end" }
  | { type: "message_end"; usage: TokenUsage; stopReason: StopReason };

export interface LLMProvider {
  readonly name: string;
  stream(params: StreamParams): AsyncIterable<StreamEvent>;
  countTokens(messages: AgentMessage[], tools?: ToolSchema[]): Promise<number>;
}
```

- [ ] **Step 4: 将 ParsedResponse 改成可判别联合类型**

将 `src/query-engine/stream.ts` 改为：

```ts
import type {
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolCall,
} from "./provider.js";

export type ParsedResponse =
  | {
      type: "text";
      content: string;
      usage: TokenUsage;
      stopReason: StopReason;
    }
  | {
      type: "tool_use";
      content?: string;
      toolCalls: ToolCall[];
      usage: TokenUsage;
      stopReason: StopReason;
    };

export async function parseStream(
  events: AsyncIterable<StreamEvent>,
  onTextDelta?: (text: string) => void,
): Promise<ParsedResponse> {
  let textContent = "";
  const toolCalls: ToolCall[] = [];
  let currentToolInput = "";
  let currentToolId = "";
  let currentToolName = "";
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "end_turn";

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        textContent += event.content;
        onTextDelta?.(event.content);
        break;
      case "tool_use_start":
        currentToolId = event.id;
        currentToolName = event.name;
        currentToolInput = "";
        break;
      case "tool_use_delta":
        currentToolInput += event.input;
        break;
      case "tool_use_end":
        toolCalls.push({
          id: currentToolId,
          name: currentToolName,
          input: JSON.parse(currentToolInput) as Record<string, unknown>,
        });
        break;
      case "message_end":
        usage = event.usage;
        stopReason = event.stopReason;
        break;
    }
  }

  if (toolCalls.length > 0) {
    return {
      type: "tool_use",
      ...(textContent.length > 0 ? { content: textContent } : {}),
      toolCalls,
      usage,
      stopReason,
    };
  }

  return { type: "text", content: textContent, usage, stopReason };
}
```

- [ ] **Step 5: 运行测试并确认通过**

Run:

```bash
npx tsx --test test/phase1/stream.test.ts
```

Expected: 1 test passed。

---

### Task 2: 收敛第一阶段 QueryEngine

**Files:**
- Modify: `src/query-engine/queryEngine.ts`
- Test: `test/phase1/query-engine.test.ts`

**Interfaces:**
- Consumes: `LLMProvider.stream(params)`、`parseStream()`。
- Produces: `QueryParams`、`QueryEngine.query(params): Promise<ParsedResponse>`。

- [ ] **Step 1: 写 QueryEngine 失败测试**

创建 `test/phase1/query-engine.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessage,
  LLMProvider,
  StreamEvent,
  StreamParams,
  ToolSchema,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/queryEngine.js";

class TextProvider implements LLMProvider {
  readonly name = "mock";
  lastParams: StreamParams | undefined;

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield { type: "text_delta", content: "完成" };
    yield {
      type: "message_end",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }

  async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 1;
  }
}

test("QueryEngine forwards params and parses provider stream", async () => {
  const provider = new TextProvider();
  const engine = new QueryEngine(provider);
  const messages: AgentMessage[] = [{ role: "user", content: "开始" }];

  const response = await engine.query({
    model: "mock-model",
    messages,
    systemPrompt: "system",
  });

  assert.equal(response.type, "text");
  if (response.type !== "text") assert.fail("expected text");
  assert.equal(response.content, "完成");
  assert.equal(provider.lastParams?.model, "mock-model");
  assert.deepEqual(provider.lastParams?.messages, messages);
});
```

- [ ] **Step 2: 运行测试并确认旧 QueryEngine 无法按单 Provider 构造**

Run:

```bash
npx tsx --test test/phase1/query-engine.test.ts
```

Expected: FAIL，`QueryEngine` 构造参数与测试不匹配，或旧依赖类型缺失。

- [ ] **Step 3: 实现第一阶段最小 QueryEngine**

将 `src/query-engine/queryEngine.ts` 改为：

```ts
import type {
  AgentMessage,
  LLMProvider,
  StreamParams,
  ToolSchema,
} from "./provider.js";
import { parseStream, type ParsedResponse } from "./stream.js";

export interface QueryParams {
  model: string;
  messages: AgentMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  abortSignal?: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export class QueryEngine {
  public constructor(private readonly provider: LLMProvider) {}

  public async query(params: QueryParams): Promise<ParsedResponse> {
    const streamParams: StreamParams = {
      model: params.model,
      messages: params.messages,
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
      ...(params.systemPrompt !== undefined
        ? { systemPrompt: params.systemPrompt }
        : {}),
      ...(params.abortSignal !== undefined
        ? { abortSignal: params.abortSignal }
        : {}),
    };

    return parseStream(
      this.provider.stream(streamParams),
      params.onTextDelta,
    );
  }
}
```

- [ ] **Step 4: 运行 QueryEngine 与 Stream 测试**

Run:

```bash
npx tsx --test test/phase1/query-engine.test.ts test/phase1/stream.test.ts
```

Expected: 2 tests passed。

---

### Task 3: 接通 ToolRegistry、Dispatcher 与 split_qa_pairs

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/tools/index.ts`
- Modify: `src/tools/tool-item/split.ts`
- Modify: `src/agent/dispatcher.ts`
- Test: `test/phase1/dispatcher.test.ts`

**Interfaces:**
- Consumes: `ToolCall`、`QueryEngine`、现有 `splitQaTool`。
- Produces: `ToolContext`、`createToolRegistry()`、`dispatchToolCall()`、`DispatchedToolResult`。

- [ ] **Step 1: 写 Dispatcher 失败测试**

创建 `test/phase1/dispatcher.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchToolCall } from "../../src/agent/dispatcher.js";
import type {
  AgentMessage,
  LLMProvider,
  StreamEvent,
  StreamParams,
  ToolSchema,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/queryEngine.js";
import { createToolRegistry } from "../../src/tools/index.js";

class UnusedProvider implements LLMProvider {
  readonly name = "unused";
  async *stream(_params: StreamParams): AsyncIterable<StreamEvent> {
    throw new Error("provider should not be called for labeled transcript");
  }
  async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 0;
  }
}

const transcript = [
  "面试官：请解释 JavaScript 闭包是什么？",
  "候选人：闭包让函数能够访问其定义时所在的词法作用域，即使外层函数已经执行结束。",
].join("\n");

test("dispatcher executes registered split_qa_pairs", async () => {
  const result = await dispatchToolCall(
    createToolRegistry(),
    {
      id: "call_1",
      name: "split_qa_pairs",
      input: { transcript, format: "labeled" },
    },
    {
      queryEngine: new QueryEngine(new UnusedProvider()),
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(result.toolCallId, "call_1");
  assert.equal(result.result.success, true);
});

test("dispatcher returns a tool result when tool is missing", async () => {
  const result = await dispatchToolCall(
    createToolRegistry(),
    { id: "call_missing", name: "missing", input: {} },
    {
      queryEngine: new QueryEngine(new UnusedProvider()),
      abortSignal: new AbortController().signal,
    },
  );

  assert.equal(result.result.success, false);
  assert.equal(result.result.error?.code, "input_error");
});
```

- [ ] **Step 2: 运行测试并确认 Dispatcher 或 ToolContext 不完整**

Run:

```bash
npx tsx --test test/phase1/dispatcher.test.ts
```

Expected: FAIL，错误包含 `dispatchToolCall` 不存在或 `ToolContext` 未定义依赖。

- [ ] **Step 3: 收敛 Tool 类型**

将 `src/tools/types.ts` 改为：

```ts
import type { QueryEngine } from "../query-engine/queryEngine.js";

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export type AnyTool = Tool<any, any>;

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: "input_error" | "service_error" | "timeout" | "permission_denied";
    message: string;
  };
}

export interface ToolContext {
  queryEngine: QueryEngine;
  abortSignal: AbortSignal;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
```

- [ ] **Step 4: 让 Registry 保存不同输入类型的工具**

将 `src/tools/registry.ts` 改为：

```ts
import type { AnyTool, ToolSchema } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  public register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`${tool.name}已经注册`);
    }
    this.tools.set(tool.name, tool);
  }

  public resolve(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`未找到工具: ${name}`);
    return tool;
  }

  public getSchemas(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  public list(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }
}
```

- [ ] **Step 5: 第一阶段明确限制 split_qa_pairs 输入范围**

修改 `src/tools/tool-item/split.ts`：

1. 删除 `QueryEngine` import。
2. 将 `raw` 分支替换为明确错误，不触发第二次隐藏的模型调用：

```ts
if (detectedFormat === "raw") {
  return {
    success: false,
    error: {
      code: "input_error",
      message: "第一阶段仅支持带角色标签的面试稿",
    },
  };
}

const pairs = splitLabeled(transcript);
return {
  success: true,
  data: {
    pairs,
    totalQuestions: pairs.length,
    format: detectedFormat,
  },
};
```

删除文件末尾的 `splitWithLLM()`。保留现有 `detectFormat()` 和 `splitLabeled()`。

- [ ] **Step 6: 第一阶段只注册 split_qa_pairs**

将 `src/tools/index.ts` 改为：

```ts
import { ToolRegistry } from "./registry.js";
import { splitQaTool } from "./tool-item/split.js";

export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(splitQaTool);
  return registry;
}
```

- [ ] **Step 7: 实现 Dispatcher**

将 `src/agent/dispatcher.ts` 改为：

```ts
import type { ToolCall } from "../query-engine/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export interface DispatchedToolResult {
  toolCallId: string;
  name: string;
  result: ToolResult;
}

export async function dispatchToolCall(
  registry: ToolRegistry,
  call: ToolCall,
  context: ToolContext,
): Promise<DispatchedToolResult> {
  try {
    const tool = registry.resolve(call.name);
    const result = await tool.execute(call.input, context);
    return { toolCallId: call.id, name: call.name, result };
  } catch (error: unknown) {
    return {
      toolCallId: call.id,
      name: call.name,
      result: {
        success: false,
        error: {
          code: "input_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}
```

- [ ] **Step 8: 运行 Dispatcher 测试**

Run:

```bash
npx tsx --test test/phase1/dispatcher.test.ts
```

Expected: 2 tests passed。

---

### Task 4: 完成 OpenAI 消息与 Tool Schema 转换

**Files:**
- Modify: `src/query-engine/providers/openai.ts`
- Test: `test/phase1/openai-provider.test.ts`

**Interfaces:**
- Consumes: `AgentMessage[]`、`ToolSchema[]`、OpenAI Chat Completions SDK。
- Produces: `OpenAIProvider`、`toOpenAIMessages()`、`toOpenAITools()`。

- [ ] **Step 1: 写消息协议转换失败测试**

创建 `test/phase1/openai-provider.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "../../src/query-engine/provider.js";
import { toOpenAIMessages } from "../../src/query-engine/providers/openai.js";

test("OpenAI adapter preserves assistant tool call and matching tool result", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "分析文字稿" },
    {
      role: "assistant",
      toolCalls: [
        {
          id: "call_1",
          name: "split_qa_pairs",
          input: { transcript: "面试稿", format: "labeled" },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: '{"success":true,"data":{"pairs":[]}}',
    },
  ];

  const converted = toOpenAIMessages(messages, "系统指令");

  assert.equal(converted[0]?.role, "system");
  assert.equal(converted[2]?.role, "assistant");
  assert.equal(converted[3]?.role, "tool");
  if (converted[3]?.role !== "tool") assert.fail("expected tool message");
  assert.equal(converted[3].tool_call_id, "call_1");
});
```

- [ ] **Step 2: 运行测试并确认 OpenAI 转换尚未实现**

Run:

```bash
npx tsx --test test/phase1/openai-provider.test.ts
```

Expected: FAIL，`toOpenAIMessages` 未导出或没有转换 Tool Result。

- [ ] **Step 3: 实现 OpenAI Provider**

将 `src/query-engine/providers/openai.ts` 改为：

```ts
import OpenAI from "openai";
import type {
  AgentMessage,
  LLMProvider,
  StopReason,
  StreamEvent,
  StreamParams,
  ToolSchema,
} from "../provider.js";

export function toOpenAIMessages(
  messages: AgentMessage[],
  systemPrompt?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const converted: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (systemPrompt !== undefined) {
    converted.push({ role: "system", content: systemPrompt });
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      converted.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      converted.push({
        role: "assistant",
        content: message.content ?? null,
        ...(message.toolCalls !== undefined
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.input),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    converted.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
  }

  return converted;
}

export function toOpenAITools(
  tools: ToolSchema[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  public constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
  }

  public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      stream: true,
      parallel_tool_calls: false,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0,
      ...(params.tools !== undefined && params.tools.length > 0
        ? { tools: toOpenAITools(params.tools) }
        : {}),
    };

    const stream = params.abortSignal
      ? await this.client.chat.completions.create(request, {
          signal: params.abortSignal,
        })
      : await this.client.chat.completions.create(request);

    let currentToolCallId = "";
    let currentToolName = "";

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;

      if (delta?.content) {
        yield { type: "text_delta", content: delta.content };
      }

      for (const toolCall of delta?.tool_calls ?? []) {
        if (toolCall.id) {
          currentToolCallId = toolCall.id;
          currentToolName = toolCall.function?.name ?? "";
          yield {
            type: "tool_use_start",
            id: currentToolCallId,
            name: currentToolName,
          };
        }

        if (toolCall.function?.arguments) {
          yield {
            type: "tool_use_delta",
            input: toolCall.function.arguments,
          };
        }
      }

      if (choice?.finish_reason) {
        if (currentToolCallId.length > 0) {
          yield { type: "tool_use_end" };
        }

        yield {
          type: "message_end",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: mapStopReason(choice.finish_reason),
        };
      }
    }
  }

  public async countTokens(messages: AgentMessage[]): Promise<number> {
    return Math.ceil(JSON.stringify(messages).length / 4);
  }
}

function mapStopReason(reason: string): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}
```

- [ ] **Step 4: 运行转换测试**

Run:

```bash
npx tsx --test test/phase1/openai-provider.test.ts
```

Expected: 1 test passed。

---

### Task 5: 实现有限步数 Agent Loop

**Files:**
- Create: `src/agent/run.ts`
- Modify: `src/agent/loop.ts`
- Test: `test/phase1/agent-loop.test.ts`

**Interfaces:**
- Consumes: `QueryEngine.query()`、`ToolRegistry.getSchemas()`、`dispatchToolCall()`。
- Produces: `AgentRun`、`RunAgentOptions`、`runAgent(input, options)`。

- [ ] **Step 1: 写完整循环失败测试**

创建 `test/phase1/agent-loop.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runAgent } from "../../src/agent/loop.js";
import type {
  AgentMessage,
  LLMProvider,
  StreamEvent,
  StreamParams,
  ToolSchema,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/queryEngine.js";
import { createToolRegistry } from "../../src/tools/index.js";

const transcript = [
  "面试官：请解释 JavaScript 闭包是什么？",
  "候选人：闭包让函数能够访问其定义时所在的词法作用域，即使外层函数已经执行结束。",
].join("\n");

class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly requests: StreamParams[] = [];

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    this.requests.push(params);

    if (this.requests.length === 1) {
      yield {
        type: "tool_use_start",
        id: "call_split",
        name: "split_qa_pairs",
      };
      yield {
        type: "tool_use_delta",
        input: JSON.stringify({ transcript, format: "labeled" }),
      };
      yield { type: "tool_use_end" };
      yield {
        type: "message_end",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      };
      return;
    }

    yield { type: "text_delta", content: "共识别出 1 道面试题。" };
    yield {
      type: "message_end",
      usage: { inputTokens: 20, outputTokens: 8 },
      stopReason: "end_turn",
    };
  }

  async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 0;
  }
}

test("agent sends tool result back with the original toolCallId", async () => {
  const provider = new ScriptedProvider();
  const answer = await runAgent(transcript, {
    queryEngine: new QueryEngine(provider),
    toolRegistry: createToolRegistry(),
    model: "mock-model",
    maxSteps: 3,
  });

  assert.equal(answer, "共识别出 1 道面试题。");
  assert.equal(provider.requests.length, 2);

  const secondMessages = provider.requests[1]?.messages ?? [];
  const assistantMessage = secondMessages.find(
    (message) => message.role === "assistant",
  );
  const toolMessage = secondMessages.find((message) => message.role === "tool");

  assert.equal(assistantMessage?.role, "assistant");
  if (assistantMessage?.role !== "assistant") {
    assert.fail("assistant tool call was not preserved");
  }
  assert.equal(assistantMessage.toolCalls?.[0]?.id, "call_split");

  assert.equal(toolMessage?.role, "tool");
  if (toolMessage?.role !== "tool") assert.fail("tool result was not preserved");
  assert.equal(toolMessage.toolCallId, "call_split");
  assert.match(toolMessage.content, /"success":true/);
});
```

- [ ] **Step 2: 运行测试并确认 Agent Loop 仍是伪代码**

Run:

```bash
npx tsx --test test/phase1/agent-loop.test.ts
```

Expected: FAIL，`runAgent` 未导出或 `Session` 等旧占位类型不存在。

- [ ] **Step 3: 创建 Run 状态**

创建 `src/agent/run.ts`：

```ts
import type { AgentMessage } from "../query-engine/provider.js";

export interface AgentRun {
  input: string;
  messages: AgentMessage[];
  step: number;
  maxSteps: number;
  abortSignal: AbortSignal;
}
```

- [ ] **Step 4: 实现 Agent Loop**

将 `src/agent/loop.ts` 改为：

```ts
import { dispatchToolCall } from "./dispatcher.js";
import type { AgentRun } from "./run.js";
import type { QueryEngine } from "../query-engine/queryEngine.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface RunAgentOptions {
  queryEngine: QueryEngine;
  toolRegistry: ToolRegistry;
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export async function runAgent(
  input: string,
  options: RunAgentOptions,
): Promise<string> {
  const run: AgentRun = {
    input,
    messages: [{ role: "user", content: input }],
    step: 0,
    maxSteps: options.maxSteps ?? 4,
    abortSignal: options.abortSignal ?? new AbortController().signal,
  };

  while (run.step < run.maxSteps) {
    if (run.abortSignal.aborted) {
      throw new Error("Agent Run 已中止");
    }

    run.step += 1;
    console.log(`\n[Agent] step=${run.step} model`);

    const response = await options.queryEngine.query({
      model: options.model,
      messages: run.messages,
      tools: options.toolRegistry.getSchemas(),
      temperature: 0,
      abortSignal: run.abortSignal,
      ...(options.systemPrompt !== undefined
        ? { systemPrompt: options.systemPrompt }
        : {}),
      ...(options.onTextDelta !== undefined
        ? { onTextDelta: options.onTextDelta }
        : {}),
    });

    if (response.type === "text") {
      const answer = response.content.trim();
      if (answer.length === 0) throw new Error("模型返回空文本");
      run.messages.push({ role: "assistant", content: answer });
      return answer;
    }

    run.messages.push({
      role: "assistant",
      ...(response.content !== undefined ? { content: response.content } : {}),
      toolCalls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      console.log(`[Agent] tool=${call.name} id=${call.id}`);
      const dispatched = await dispatchToolCall(
        options.toolRegistry,
        call,
        {
          queryEngine: options.queryEngine,
          abortSignal: run.abortSignal,
        },
      );

      run.messages.push({
        role: "tool",
        toolCallId: dispatched.toolCallId,
        content: JSON.stringify(dispatched.result),
      });
    }
  }

  throw new Error(`Agent 超出最大循环次数：${run.maxSteps}`);
}
```

- [ ] **Step 5: 运行 Agent Loop 测试**

Run:

```bash
npx tsx --test test/phase1/agent-loop.test.ts
```

Expected: 1 test passed，控制台依次出现 `step=1`、`tool=split_qa_pairs`、`step=2`。

---

### Task 6: 增加配置、CLI 与第一阶段验证脚本

**Files:**
- Create: `src/config.ts`
- Create: `src/index.ts`
- Create: `tsconfig.phase1.json`
- Create: `test/phase1/config.test.ts`
- Create: `test/fixtures/labeled-interview.txt`
- Modify: `package.json`

**Interfaces:**
- Consumes: `OpenAIProvider`、`QueryEngine`、`createToolRegistry()`、`runAgent()`。
- Produces: `loadConfig()` 与 `npm run agent -- <transcript-file>`。

- [ ] **Step 1: 写配置失败测试**

创建 `test/phase1/config.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";

test("loadConfig requires an API key and defaults the OpenAI model", () => {
  assert.throws(() => loadConfig({}), /LLM_API_KEY/);

  assert.deepEqual(loadConfig({ LLM_API_KEY: "test-key" }), {
    apiKey: "test-key",
    model: "gpt-4.1-mini",
  });
});
```

- [ ] **Step 2: 运行配置测试并确认文件不存在**

Run:

```bash
npx tsx --test test/phase1/config.test.ts
```

Expected: FAIL，无法找到 `src/config.ts`。

- [ ] **Step 3: 创建无 Zod 配置读取器**

创建 `src/config.ts`：

```ts
export interface AgentConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) throw new Error("缺少环境变量 LLM_API_KEY");

  const baseURL = env.LLM_BASE_URL?.trim();
  return {
    apiKey,
    model: env.LLM_MODEL_ID?.trim() || "gpt-4.1-mini",
    ...(baseURL ? { baseURL } : {}),
  };
}
```

- [ ] **Step 4: 创建 CLI 入口**

创建 `src/index.ts`：

```ts
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "./agent/loop.js";
import { loadConfig } from "./config.js";
import { OpenAIProvider } from "./query-engine/providers/openai.js";
import { QueryEngine } from "./query-engine/queryEngine.js";
import { createToolRegistry } from "./tools/index.js";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("用法：npm run agent -- <面试文字稿路径>");
  }

  const transcript = await readFile(resolve(process.cwd(), inputPath), "utf8");
  const config = loadConfig();
  const provider = new OpenAIProvider(config.apiKey, config.baseURL);
  const queryEngine = new QueryEngine(provider);

  const answer = await runAgent(transcript, {
    queryEngine,
    toolRegistry: createToolRegistry(),
    model: config.model,
    maxSteps: 4,
    systemPrompt: [
      "你是面试诊断 Agent。",
      "收到面试文字稿后，必须先调用 split_qa_pairs。",
      "得到工具结果后，说明识别到多少组问答，并简要列出问题。",
      "不要编造工具没有返回的内容。",
    ].join("\n"),
    onTextDelta: (text) => process.stdout.write(text),
  });

  console.log("\n\n========== 最终结果 ==========");
  console.log(answer);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nAgent 运行失败：${message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: 创建测试文字稿**

创建 `test/fixtures/labeled-interview.txt`：

```text
面试官：请解释 JavaScript 闭包是什么，并说一个实际使用场景。
候选人：闭包是函数和其词法环境的组合。即使外层函数执行结束，内部函数仍然可以访问外层变量。例如 React 自定义 Hook 可以通过闭包保存一次调用相关的状态和配置。
```

- [ ] **Step 6: 创建第一阶段 TypeScript 边界**

创建 `tsconfig.phase1.json`：

```json
{
  "extends": "./tsconfig.json",
  "include": [
    "src/config.ts",
    "src/index.ts",
    "src/agent/run.ts",
    "src/agent/loop.ts",
    "src/agent/dispatcher.ts",
    "src/query-engine/provider.ts",
    "src/query-engine/stream.ts",
    "src/query-engine/queryEngine.ts",
    "src/query-engine/providers/openai.ts",
    "src/tools/types.ts",
    "src/tools/registry.ts",
    "src/tools/index.ts",
    "src/tools/tool-item/split.ts",
    "test/phase1/**/*.test.ts"
  ]
}
```

- [ ] **Step 7: 增加运行脚本**

在 `package.json` 的 `scripts` 中增加：

```json
{
  "agent": "tsx src/index.ts",
  "test:phase1": "tsx --test test/phase1/*.test.ts",
  "typecheck:phase1": "tsc -p tsconfig.phase1.json --noEmit"
}
```

保留已有脚本，不修改依赖。

- [ ] **Step 8: 运行第一阶段全部自动验证**

Run:

```bash
npm run typecheck:phase1
npm run test:phase1
```

Expected:

- `typecheck:phase1` exit code 0。
- 7 tests passed：Stream 1、QueryEngine 1、Dispatcher 2、OpenAI Provider 1、Agent Loop 1、Config 1。

- [ ] **Step 9: 安全确认本地 API Key 可被 dotenv 加载**

Run:

```bash
node --input-type=module -e "import 'dotenv/config'; console.log(Boolean(process.env.LLM_API_KEY))"
```

Expected: 输出 `true`，不显示 Key 内容。

- [ ] **Step 10: 运行真实 OpenAI Tool Calling 闭环**

Run:

```bash
npm run agent -- test/fixtures/labeled-interview.txt
```

Expected output contains, in order:

```text
[Agent] step=1 model
[Agent] tool=split_qa_pairs id=
[Agent] step=2 model
========== 最终结果 ==========
```

最终文本必须明确说明识别到 1 组问答。若模型未调用工具、Tool 参数无法解析或第二轮收到 OpenAI 的 Tool Message 协议错误，应保留原始错误作为下一轮 Harness 加固输入，不在本任务中用 Prompt 掩盖。

---

## Final Verification

- [ ] `npm run typecheck:phase1` 通过。
- [ ] `npm run test:phase1` 显示 7 tests passed。
- [ ] 真实运行日志出现两次模型步骤和一次 `split_qa_pairs` 工具调用。
- [ ] Tool Result 使用与 Assistant Tool Call 相同的 `toolCallId`。
- [ ] 最终文本只基于工具返回的 Q&A 数据。
- [ ] 未注册或调用知识库、内容诊断、报告、语音及 Sub-agent。
