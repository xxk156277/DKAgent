import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { AgentLoop } from "../../src/agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../../src/agent/prompt.js";
import { MemoryExtractor } from "../../src/memory/extractor.js";
import type { AgentLoopOptions } from "../../src/agent/types.js";
import {
    ContextManager,
    ProviderTokenCounter,
} from "../../src/context/index.js";
import type {
    ContextBuilder,
    ContextBuildInput,
    ContextSnapshot,
} from "../../src/context/types.js";
import type {
    AgentMessage,
    LLMProvider,
    StreamEvent,
    StreamParams,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import type { SessionSnapshot, SessionStore } from "../../src/session/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool, ToolResult } from "../../src/tools/types.js";
import type { MemoryReader, MemoryWriter } from "../../src/memory/types.js";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";
import type { ArtifactStore } from "../../src/artifact/types.js";

class FakeProvider implements LLMProvider {
    readonly name = "fake";
    readonly requests: StreamParams[] = [];

    constructor(private readonly responses: StreamEvent[][]) { }

    async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        const response = this.responses.shift();
        if (!response) throw new Error("FakeProvider 没有可用响应");

        for (const event of response) yield event;
    }

    async countTokens(): Promise<number> {
        return 0;
    }
}

const usage = { inputTokens: 1, outputTokens: 1 };

function textResponse(
    content: string,
    stopReason: Extract<StreamEvent, { type: "message_end" }>["stopReason"] = "end_turn",
): StreamEvent[] {
    return [
        { type: "text_delta", content },
        { type: "message_end", usage, stopReason },
    ];
}

function createAgent(
    provider: FakeProvider,
    registry = new ToolRegistry(),
    contextManager: ContextBuilder = new ContextManager(
        new ProviderTokenCounter(provider),
    ),
    tracer?: Tracer,
    artifactStore?: ArtifactStore,
): AgentLoop {
    return new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer ?? new Tracer()),
        toolRegistry: registry,
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        ...(tracer === undefined ? {} : { tracer }),
        ...(artifactStore === undefined ? {} : { artifactStore }),
    });
}

/** 测试用 ContextBuilder：模型每次只能看到最新一条消息。 */
class LatestMessageContextBuilder implements ContextBuilder {
    async build(input: ContextBuildInput): Promise<ContextSnapshot> {
        const latestMessage = input.messages.at(-1);
        return {
            ...(input.systemPrompt === undefined
                ? {}
                : { systemPrompt: input.systemPrompt }),
            messages: latestMessage ? [latestMessage] : [],
            tools: [...input.tools],
        };
    }
}

/** 测试用 ContextBuilder：每次构建都推进一次会话摘要状态。 */
class AdvancingContextBuilder implements ContextBuilder {
    public readonly receivedSummaries: string[] = [];

    async build(input: ContextBuildInput): Promise<ContextSnapshot> {
        const state = input.compaction?.state;
        if (!state) {
            throw new Error("测试期望 AgentLoop 传入压缩状态");
        }

        this.receivedSummaries.push(state.summary);
        const nextNumber = this.receivedSummaries.length;

        return {
            ...(input.systemPrompt === undefined
                ? {}
                : { systemPrompt: input.systemPrompt }),
            messages: [...input.messages],
            tools: [...input.tools],
            nextContextState: {
                summary: `第 ${nextNumber} 次摘要`,
                firstKeptMessageIndex: state.firstKeptMessageIndex,
            },
        };
    }
}

/** 记录 AgentLoop 传给 ContextManager 的 System Prompt。 */
class RecordingContextBuilder implements ContextBuilder {
    public readonly systemPrompts: Array<string | undefined> = [];

    async build(input: ContextBuildInput): Promise<ContextSnapshot> {
        this.systemPrompts.push(input.systemPrompt);
        return {
            ...(input.systemPrompt === undefined
                ? {}
                : { systemPrompt: input.systemPrompt }),
            messages: [...input.messages],
            tools: [...input.tools],
        };
    }
}

/** 只实现本组断言会调用的 SessionStore 方法。 */
function createMemoryTestSession(appendedMessages: AgentMessage[]): NonNullable<
    AgentLoopOptions["session"]
> {
    const snapshot: SessionSnapshot = {
        id: "session-memory",
        messages: [],
        contextState: {
            summary: "",
            firstKeptMessageIndex: 0,
        },
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
    };
    const store: SessionStore = {
        create() {
            return snapshot;
        },
        loadLatest() {
            return snapshot;
        },
        list() {
            return [];
        },
        load(sessionId) {
            return sessionId === snapshot.id ? snapshot : null;
        },
        delete() {
            return false;
        },
        appendMessage(_sessionId, message) {
            appendedMessages.push(structuredClone(message));
        },
        saveContextState() { },
    };
    return {
        snapshot,
        store,
    };
}

test("普通聊天直接返回文本，不执行 Tool", async () => {
    const provider = new FakeProvider([textResponse("你好，我是 DKAgent")]);
    const agent = createAgent(provider);

    const answer = await agent.run("你好");

    assert.equal(answer, "你好，我是 DKAgent");
    assert.deepEqual(agent.getMessages(), [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，我是 DKAgent" },
    ]);
});

test("连续调用时保留之前的对话消息", async () => {
    const provider = new FakeProvider([
        textResponse("第一轮回答"),
        textResponse("第二轮回答"),
    ]);
    const agent = createAgent(provider);

    await agent.run("第一轮问题");
    await agent.run("第二轮问题");

    assert.deepEqual(provider.requests[1]?.messages, [
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "第二轮问题" },
    ]);
});

test("模型使用 Context 快照，但 AgentLoop 保留完整历史", async () => {
    const provider = new FakeProvider([
        textResponse("第一轮回答"),
        textResponse("第二轮回答"),
    ]);
    const agent = createAgent(
        provider,
        new ToolRegistry(),
        new LatestMessageContextBuilder(),
    );

    await agent.run("第一轮问题");
    await agent.run("第二轮问题");

    assert.deepEqual(provider.requests[1]?.messages, [
        { role: "user", content: "第二轮问题" },
    ]);
    assert.deepEqual(agent.getMessages(), [
        { role: "user", content: "第一轮问题" },
        { role: "assistant", content: "第一轮回答" },
        { role: "user", content: "第二轮问题" },
        { role: "assistant", content: "第二轮回答" },
    ]);
});

test("AgentLoop 每轮传入并保存 ContextManager 返回的摘要状态", async () => {
    const provider = new FakeProvider([
        textResponse("第一轮回答"),
        textResponse("第二轮回答"),
    ]);
    const contextManager = new AdvancingContextBuilder();
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        contextCompaction: {
            enabled: true,
            triggerRatio: 0.8,
            targetRatio: 0.6,
            maxSummaryTokens: 100,
            maxToolResultChars: 2_000,
        },
    });

    await agent.run("第一轮问题");
    await agent.run("第二轮问题");

    assert.deepEqual(
        contextManager.receivedSummaries,
        ["", "第 1 次摘要"],
    );
    assert.deepEqual(agent.getContextState(), {
        summary: "第 2 次摘要",
        firstKeptMessageIndex: 0,
    });
    assert.equal(agent.getMessages().length, 4);
});

test("Tool Call 执行后将结果回传模型", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-1", name: "test_analysis" },
            {
                type: "tool_call_delta",
                index: 0,
                argumentsDelta: '{"transcriptPath":"/tmp/test-short.md"}',
            },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("面试分析完成"),
    ]);
    let executeCount = 0;
    const fakeAnalyzeTool: Tool<{ transcriptPath: string }, { reportPath: string }> = {
        name: "test_analysis",
        description: "测试工具",
        parameters: { type: "object" },
        async execute(input) {
            executeCount += 1;
            assert.equal(input.transcriptPath, "/tmp/test-short.md");
            return { success: true, data: { reportPath: "/tmp/report.md" } };
        },
    };
    const registry = new ToolRegistry();
    registry.register(fakeAnalyzeTool);
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const agent = createAgent(
        provider,
        registry,
        new ContextManager(new ProviderTokenCounter(provider), undefined, tracer),
        tracer,
    );

    const answer = await agent.run("帮我诊断 packages/agent/test/test-short.md");

    assert.equal(answer, "面试分析完成");
    assert.equal(executeCount, 1);
    assert.deepEqual(provider.requests[1]?.messages.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
    ]);
    assert.deepEqual(traceStore.list().filter((span) => span.name === "tool.execute").length, 1);
});

test("终点 Tool 在协议消息完整后原样返回并持久化最终文本", async () => {
    const markdown = ["# 完整报告", "", "逐题分析".repeat(500)].join("\n");
    const provider = new FakeProvider([[
        { type: "tool_call_start", index: 0, id: "call-final", name: "final_output" },
        {
            type: "tool_call_delta",
            index: 0,
            argumentsDelta: JSON.stringify({ returnDirectly: true }),
        },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_start", index: 1, id: "call-auxiliary", name: "auxiliary" },
        { type: "tool_call_delta", index: 1, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 1 },
        { type: "message_end", usage, stopReason: "tool_use" },
    ]]);
    const registry = new ToolRegistry();
    const terminalTool: Tool<{ returnDirectly: boolean }, { markdown: string }> & {
        getFinalOutput(
            input: { returnDirectly: boolean },
            result: ToolResult<{ markdown: string }>,
        ): string | undefined;
    } = {
        name: "final_output",
        description: "返回最终文本",
        parameters: {
            type: "object",
            properties: { returnDirectly: { type: "boolean" } },
            additionalProperties: false,
        },
        async execute() {
            return { success: true, data: { markdown } };
        },
        getFinalOutput(input, result) {
            return input.returnDirectly && result.success ? result.data?.markdown : undefined;
        },
    };
    registry.register(terminalTool);
    let auxiliaryExecuteCount = 0;
    registry.register({
        name: "auxiliary",
        description: "同一批次普通工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            auxiliaryExecuteCount += 1;
            return { success: true, data: { completed: true } };
        },
    });
    const sessionMessages: AgentMessage[] = [];
    const deltas: string[] = [];
    const captures: Array<{ userInput: string; assistantAnswer: string; sessionId: string }> = [];
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        onTextDelta: (text) => deltas.push(text),
        memoryWriter: {
            async capture(input) {
                captures.push(input);
            },
        },
        session: createMemoryTestSession(sessionMessages),
    });

    assert.equal(await agent.run("生成完整报告"), markdown);
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.requests[0]?.messages[0], {
        role: "user",
        content: "生成完整报告",
    });
    assert.equal(auxiliaryExecuteCount, 1);
    assert.deepEqual(agent.getMessages().map((message) => message.role), [
        "user",
        "assistant",
        "tool",
        "tool",
        "assistant",
    ]);
    assert.deepEqual(sessionMessages, agent.getMessages());
    assert.deepEqual(agent.getMessages().at(-1), { role: "assistant", content: markdown });
    assert.deepEqual(deltas, [markdown]);
    assert.deepEqual(captures, []);
});

test("终点 Tool 失败时继续交回模型且普通文本不重复推送", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-failed-final", name: "failed_final" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("模型处理失败结果"),
    ]);
    const registry = new ToolRegistry();
    registry.register({
        name: "failed_final",
        description: "失败终点工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            return {
                success: false,
                error: { code: "input_error" as const, message: "报告输入无效" },
            };
        },
        getFinalOutput(_input, result) {
            return result.success ? "不应返回" : undefined;
        },
    });
    const deltas: string[] = [];
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        onTextDelta: (text) => deltas.push(text),
    });

    assert.equal(await agent.run("生成报告"), "模型处理失败结果");
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(deltas, ["模型处理失败结果"]);
    assert.deepEqual(agent.getMessages().map((message) => message.role), [
        "user",
        "assistant",
        "tool",
        "assistant",
    ]);
});

test("Tool 执行期间中止时完成整批协议配对但不输出终点文本", async () => {
    const controller = new AbortController();
    const markdown = "# 不应输出的报告";
    const provider = new FakeProvider([[
        { type: "tool_call_start", index: 0, id: "call-aborted-final", name: "aborted_final" },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_start", index: 1, id: "call-after-abort", name: "after_abort" },
        { type: "tool_call_delta", index: 1, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 1 },
        { type: "message_end", usage, stopReason: "tool_use" },
    ]]);
    const registry = new ToolRegistry();
    registry.register({
        name: "aborted_final",
        description: "执行中中止的终点工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            controller.abort();
            return { success: true, data: { markdown } };
        },
        getFinalOutput(_input, result) {
            return result.success ? result.data?.markdown : undefined;
        },
    });
    let afterAbortExecuteCount = 0;
    registry.register({
        name: "after_abort",
        description: "中止后仍需完成配对的工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            afterAbortExecuteCount += 1;
            return { success: true, data: { completed: true } };
        },
    });
    const sessionMessages: AgentMessage[] = [];
    const deltas: string[] = [];
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        abortSignal: controller.signal,
        onTextDelta: (text) => deltas.push(text),
        session: createMemoryTestSession(sessionMessages),
    });

    await assert.rejects(agent.run("生成报告"), /Agent Run 已中止/);
    assert.equal(afterAbortExecuteCount, 1);
    assert.deepEqual(sessionMessages.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
        "tool",
    ]);
    assert.equal(
        sessionMessages.some((message) => (
            message.role === "assistant" && message.content === markdown
        )),
        false,
    );
    assert.equal(sessionMessages.at(-1)?.role, "tool");
    assert.deepEqual(deltas, []);
});

test("终点提取 hook 抛错前已执行并持久化整批 Tool Result", async () => {
    const provider = new FakeProvider([[
        { type: "tool_call_start", index: 0, id: "call-throwing-final", name: "throwing_final" },
        { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_start", index: 1, id: "call-after-hook", name: "after_hook" },
        { type: "tool_call_delta", index: 1, argumentsDelta: "{}" },
        { type: "tool_call_end", index: 1 },
        { type: "message_end", usage, stopReason: "tool_use" },
    ]]);
    const registry = new ToolRegistry();
    registry.register({
        name: "throwing_final",
        description: "提取失败的终点工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            return { success: true, data: { markdown: "报告" } };
        },
        getFinalOutput() {
            throw new Error("终点提取失败");
        },
    });
    let afterHookExecuteCount = 0;
    registry.register({
        name: "after_hook",
        description: "hook 后续工具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
            afterHookExecuteCount += 1;
            return { success: true, data: { completed: true } };
        },
    });
    const sessionMessages: AgentMessage[] = [];
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        session: createMemoryTestSession(sessionMessages),
    });

    await assert.rejects(agent.run("生成报告"), /终点提取失败/);
    assert.equal(afterHookExecuteCount, 1);
    assert.deepEqual(sessionMessages.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
        "tool",
    ]);
});

test("Tool Call 接收 AgentLoop 注入的 ArtifactStore", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-store", name: "capture_store" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("已捕获 Store"),
    ]);
    let receivedStore: ArtifactStore | undefined;
    const registry = new ToolRegistry();
    registry.register({
        name: "capture_store",
        description: "捕获 ArtifactStore",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, ctx) {
            receivedStore = ctx.artifactStore;
            return { success: true, data: { captured: true } };
        },
    });

    const artifactStore = new InMemoryArtifactStore();
    const agent = createAgent(provider, registry, undefined, undefined, artifactStore);
    await agent.run("运行");

    assert.strictEqual(receivedStore, artifactStore);
});

test("Tool Call 在未注入 Store 时接收默认 InMemoryArtifactStore", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-default-store", name: "capture_store" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("已捕获默认 Store"),
    ]);
    let receivedStore: ArtifactStore | undefined;
    const registry = new ToolRegistry();
    registry.register({
        name: "capture_store",
        description: "捕获默认 ArtifactStore",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, ctx) {
            receivedStore = ctx.artifactStore;
            return { success: true, data: { captured: true } };
        },
    });

    await createAgent(provider, registry).run("运行");

    assert.ok(receivedStore instanceof InMemoryArtifactStore);
});

test("Agent 失败时记录 agent.turn error 后原样抛出错误", async () => {
    const expectedError = new Error("context failed");
    const failedContextBuilder: ContextBuilder = {
        async build() {
            throw expectedError;
        },
    };
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const agent = createAgent(
        new FakeProvider([]),
        new ToolRegistry(),
        failedContextBuilder,
        tracer,
    );

    await assert.rejects(agent.run("你好"), (error: unknown) => {
        assert.equal(error, expectedError);
        return true;
    });
    const errorSpan = traceStore.list().find((span) => span.name === "agent.turn");
    assert.equal(errorSpan?.status, "error");
    assert.equal(errorSpan?.error?.message, "context failed");
});

test("同一 Turn 的 Tool 两 Step 只召回一次，并复用同一段记忆", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-memory", name: "test_tool" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("最终回答"),
    ]);
    const registry = new ToolRegistry();
    registry.register({
        name: "test_tool",
        description: "测试工具",
        parameters: { type: "object" },
        async execute() {
            return { success: true, data: {} };
        },
    });
    const contextManager = new RecordingContextBuilder();
    const recallQueries: string[] = [];
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const reader: MemoryReader = {
        async recall(query) {
            recallQueries.push(query);
            return "<recalled_memory>用户偏好简洁</recalled_memory>";
        },
    };

    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer),
        toolRegistry: registry,
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        memoryReader: reader,
        tracer,
    });

    assert.equal(await agent.run("请使用工具"), "最终回答");
    assert.deepEqual(recallQueries, ["请使用工具"]);
    const recallEvents = traceStore.list().filter((span) => span.name === "memory.recall");
    assert.equal(recallEvents.length, 1);
    assert.deepEqual(recallEvents[0]?.output, { content: "<recalled_memory>用户偏好简洁</recalled_memory>", characterCount: 41 });
    assert.deepEqual(contextManager.systemPrompts, [
        "test prompt\n\n<recalled_memory>用户偏好简洁</recalled_memory>",
        "test prompt\n\n<recalled_memory>用户偏好简洁</recalled_memory>",
    ]);
});

test("canonical turn/step/model/tool flow has one owner and typed parent chain", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-read", name: "read_file" },
            { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a"}' },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("done"),
    ]);
    const registry = new ToolRegistry();
    registry.register({
        name: "read_file", description: "read", parameters: { type: "object" },
        async execute(input) { return { success: true, data: { path: input.path } }; },
    });
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer), toolRegistry: registry,
        contextManager: new RecordingContextBuilder(), model: "fake-model",
        maxContextTokens: 1000, maxOutputTokens: 100, tracer,
    });
    assert.equal(await agent.run("read"), "done");
    const spans = store.list();
    assert.deepEqual(spans.map((span) => span.name), [
        "agent.turn", "agent.step", "model.generate", "tool.execute", "agent.step", "model.generate",
    ]);
    const root = spans[0]!;
    assert.equal(spans[1]!.parentSpanId, root.spanId);
    assert.equal(spans[2]!.parentSpanId, spans[1]!.spanId);
    assert.equal(spans[3]!.parentSpanId, spans[1]!.spanId);
    assert.equal(spans[4]!.parentSpanId, root.spanId);
    assert.equal(spans[5]!.parentSpanId, spans[4]!.spanId);
    assert.deepEqual(spans[3]!.input, { toolCallId: "call-read", name: "read_file", input: { path: "a" } });
    assert.deepEqual(spans[3]!.output, { success: true, data: { path: "a" } });
    assert.equal(spans.filter((span) => span.name === "model.generate").length, 2);
    assert.equal(spans.filter((span) => span.name === "model.generate").every((span) => span.tokenUsage && span.durationMs !== undefined), true);
});

test("AgentLoop inherits QueryEngine tracer when options.tracer is omitted", async () => {
    const provider = new FakeProvider([textResponse("inherited")]);
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    const agent = new AgentLoop({
        queryEngine: engine, toolRegistry: new ToolRegistry(), contextManager: new RecordingContextBuilder(),
        model: "fake-model", maxContextTokens: 1000, maxOutputTokens: 100,
    });
    assert.equal(await agent.run("hello"), "inherited");
    assert.deepEqual(store.list().map((span) => span.name), ["agent.turn", "agent.step", "model.generate"]);
});

test("AgentLoop rejects a tracer different from QueryEngine tracer", () => {
    const provider = new FakeProvider([]);
    const queryTracer = new Tracer();
    const loopTracer = new Tracer();
    assert.throws(() => new AgentLoop({
        queryEngine: new QueryEngine(provider, queryTracer), tracer: loopTracer,
        toolRegistry: new ToolRegistry(), contextManager: new RecordingContextBuilder(),
        model: "fake-model", maxContextTokens: 1000, maxOutputTokens: 100,
    }), /AgentLoop tracer must match QueryEngine tracer/);
});

test("召回记忆保留在真实模型请求、memory.recall 与 model.generate Trace", async () => {
    const memoryFact = "用户偏好先讲结论";
    const provider = new FakeProvider([textResponse("回答")]);
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer),
        toolRegistry: new ToolRegistry(),
        contextManager: new ContextManager(
            new ProviderTokenCounter(provider),
            undefined,
            tracer,
        ),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        memoryReader: {
            async recall() {
                return `<recalled_memory>${memoryFact}</recalled_memory>`;
            },
        },
        tracer,
    });

    await agent.run("问题");

    assert.match(provider.requests[0]?.systemPrompt ?? "", new RegExp(memoryFact));
    const recall = traceStore.list().find((span) => span.name === "memory.recall");
    const model = traceStore.list().find((span) => span.name === "model.generate");
    assert.match(JSON.stringify(recall), new RegExp(memoryFact));
    assert.match(JSON.stringify(model), new RegExp(memoryFact));
});

test("召回记忆只注入 Context System Prompt，不进入历史或 Session", async () => {
    const provider = new FakeProvider([textResponse("回答")]);
    const contextManager = new RecordingContextBuilder();
    const sessionMessages: AgentMessage[] = [];
    const reader: MemoryReader = {
        async recall() {
            return "<recalled_memory>跨 Session 事实</recalled_memory>";
        },
    };
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        memoryReader: reader,
        session: createMemoryTestSession(sessionMessages),
    });

    await agent.run("问题");

    assert.equal(
        contextManager.systemPrompts[0],
        "test prompt\n\n<recalled_memory>跨 Session 事实</recalled_memory>",
    );
    assert.doesNotMatch(JSON.stringify(agent.getMessages()), /跨 Session 事实/);
    assert.doesNotMatch(JSON.stringify(sessionMessages), /跨 Session 事实/);
});

test("成功最终文本追加后按 Session 捕获记忆", async () => {
    const provider = new FakeProvider([textResponse("最终回答")]);
    const sessionMessages: AgentMessage[] = [];
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const captures: Array<{ userInput: string; assistantAnswer: string; sessionId: string }> = [];
    const writer: MemoryWriter = {
        async capture(input) {
            assert.deepEqual(sessionMessages.at(-1), {
                role: "assistant",
                content: "最终回答",
            });
            captures.push(input);
        },
    };
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: writer,
        session: createMemoryTestSession(sessionMessages),
        tracer,
    });

    assert.equal(await agent.run("原始问题"), "最终回答");
    assert.deepEqual(captures, [{
        userInput: "原始问题",
        assistantAnswer: "最终回答",
        sessionId: "session-memory",
    }]);
    assert.deepEqual(sessionMessages.at(-1), { role: "assistant", content: "最终回答" });
    assert.equal(traceStore.list().some((span) => span.name === "memory.write"), false);

    const noSessionAgent = new AgentLoop({
        queryEngine: new QueryEngine(new FakeProvider([textResponse("无 Session 回答")])),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: writer,
    });
    assert.equal(await noSessionAgent.run("无 Session 问题"), "无 Session 回答");
    assert.equal(captures.length, 1);
});

test("max_tokens 和 content_filter 文本仍返回并保存 Session，但不自动捕获记忆", async () => {
    const provider = new FakeProvider([
        textResponse("达到输出上限", "max_tokens"),
        textResponse("触发内容过滤", "content_filter"),
    ]);
    const sessionMessages: AgentMessage[] = [];
    const captures: Array<{ userInput: string; assistantAnswer: string; sessionId: string }> = [];
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: {
            async capture(input) {
                captures.push(input);
            },
        },
        session: createMemoryTestSession(sessionMessages),
    });

    assert.equal(await agent.run("问题一"), "达到输出上限");
    assert.equal(await agent.run("问题二"), "触发内容过滤");
    assert.deepEqual(captures, []);
    assert.deepEqual(sessionMessages, [
        { role: "user", content: "问题一" },
        { role: "assistant", content: "达到输出上限" },
        { role: "user", content: "问题二" },
        { role: "assistant", content: "触发内容过滤" },
    ]);
});

test("Memory 失败降级，空文本或循环失败不捕获", async () => {
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const reader: MemoryReader = {
        async recall() {
            throw new Error("recall failed");
        },
    };
    const writer: MemoryWriter = {
        async capture() {
            throw new Error("capture failed");
        },
    };
    const normalAgent = new AgentLoop({
        queryEngine: new QueryEngine(new FakeProvider([textResponse("正常回答")]), tracer),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryReader: reader,
        memoryWriter: writer,
        tracer,
        session: createMemoryTestSession([]),
    });

    assert.equal(await normalAgent.run("问题"), "正常回答");
    assert.equal(traceStore.list().some((span) => span.name === "memory.recall" && span.status === "error"), true);
    assert.equal(traceStore.list().some((span) => span.name === "memory.write"), false);

    const captures: Array<{ userInput: string; assistantAnswer: string; sessionId: string }> = [];
    const captureRecorder: MemoryWriter = {
        async capture(input) {
            captures.push(input);
        },
    };
    const emptyAnswerAgent = new AgentLoop({
        queryEngine: new QueryEngine(new FakeProvider([textResponse("  ")])),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: captureRecorder,
        session: createMemoryTestSession([]),
    });
    await assert.rejects(emptyAnswerAgent.run("空文本"), /模型返回空文本/);

    const loopAgent = new AgentLoop({
        queryEngine: new QueryEngine(new FakeProvider([[
            { type: "tool_call_start", index: 0, id: "call-loop", name: "test_tool" },
            { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ]])),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        maxSteps: 1,
        memoryWriter: captureRecorder,
        session: createMemoryTestSession([]),
    });
    await assert.rejects(loopAgent.run("循环失败"), /Agent 超出最大循环次数/);
    assert.deepEqual(captures, []);
});

test("System Prompt 只定义面试成长 Agent 的稳定核心契约", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /面试成长 Agent/);
    assert.match(AGENT_SYSTEM_PROMPT, /准备面试、复盘表现、识别能力差距/);
    assert.match(AGENT_SYSTEM_PROMPT, /关于用户经历、动态事实、外部或私有数据的事实结论/);
    assert.match(AGENT_SYSTEM_PROMPT, /用户材料、能力返回结果或当前上下文直接支撑/);
    assert.match(AGENT_SYSTEM_PROMPT, /可靠的通用面试知识可以直接回答/);
    assert.match(AGENT_SYSTEM_PROMPT, /可能变化或无法确定的信息必须标记为“不确定”，必要时使用能力验证/);
    assert.match(AGENT_SYSTEM_PROMPT, /推断/);
    assert.match(AGENT_SYSTEM_PROMPT, /待确认.*不确定/);
    assert.match(AGENT_SYSTEM_PROMPT, /运行时提供的能力元数据/);
    assert.match(AGENT_SYSTEM_PROMPT, /安全只读能力可以直接使用/);
    assert.match(AGENT_SYSTEM_PROMPT, /写入、删除、外部发送、付费、高风险操作或任务范围扩张/);
    assert.match(AGENT_SYSTEM_PROMPT, /能力失败时如实说明错误/);
    assert.match(AGENT_SYSTEM_PROMPT, /简单的范围外问题可以简短回答/);
    assert.doesNotMatch(AGENT_SYSTEM_PROMPT, /find_files|analyze_interview/);
})

test("MemoryExtractor 模型错误不影响 AgentLoop 最终回答", async () => {
    const userInput = "用户原文仍应正常回答";
    const answer = "正常最终回答";
    const extractor = new MemoryExtractor({
        async query() {
            throw new Error(`${userInput}; ${answer}; 候选正文`);
        },
    }, "memory-model");
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(new FakeProvider([textResponse(answer)])),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: {
            async capture(input) {
                await extractor.extract(input);
            },
        },
        session: createMemoryTestSession([]),
    });

    assert.equal(await agent.run(userInput), answer);
});
