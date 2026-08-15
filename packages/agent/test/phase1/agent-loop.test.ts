import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { AgentLoop } from "../../src/agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../../src/agent/prompt.js";
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
import type { Tool } from "../../src/tools/types.js";
import type { MemoryReader, MemoryWriter } from "../../src/memory/types.js";

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
): AgentLoop {
    return new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        ...(tracer === undefined ? {} : { tracer }),
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
        saveContextState() {},
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

test("诊断意图产生 Tool Call 后，将结果回传模型", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-1", name: "split_qa_pairs" },
            {
                type: "tool_call_delta",
                index: 0,
                argumentsDelta: '{"transcriptPath":"packages/agent/test/test-short.md"}',
            },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ],
        textResponse("已拆分 1 组问答"),
    ]);
    let executeCount = 0;
    const fakeSplitTool: Tool<{ transcriptPath: string }, { totalQuestions: number }> = {
        name: "split_qa_pairs",
        description: "测试拆题工具",
        parameters: { type: "object" },
        async execute(input) {
            executeCount += 1;
            assert.equal(input.transcriptPath, "packages/agent/test/test-short.md");
            return { success: true, data: { totalQuestions: 1 } };
        },
    };
    const registry = new ToolRegistry();
    registry.register(fakeSplitTool);
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const agent = createAgent(
        provider,
        registry,
        new ContextManager(new ProviderTokenCounter(provider), undefined, tracer),
        tracer,
    );

    const answer = await agent.run("帮我诊断 packages/agent/test/test-short.md");

    assert.equal(answer, "已拆分 1 组问答");
    assert.equal(executeCount, 1);
    assert.deepEqual(provider.requests[1]?.messages.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
    ]);
    assert.ok(traceStore.list().some((event) => event.name === "tool.call"));
    assert.ok(traceStore.list().some((event) => event.name === "tool.result"));
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
    const errorEvent = traceStore.list().find(
        (event) => event.name === "agent.turn" && event.phase === "error",
    );
    assert.equal(
        (errorEvent?.data as { error: { message: string } }).error.message,
        "context failed",
    );
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
    const reader: MemoryReader = {
        async recall(query) {
            recallQueries.push(query);
            return "<recalled_memory>用户偏好简洁</recalled_memory>";
        },
    };

    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        memoryReader: reader,
    });

    assert.equal(await agent.run("请使用工具"), "最终回答");
    assert.deepEqual(recallQueries, ["请使用工具"]);
    assert.deepEqual(contextManager.systemPrompts, [
        "test prompt\n\n<recalled_memory>用户偏好简洁</recalled_memory>",
        "test prompt\n\n<recalled_memory>用户偏好简洁</recalled_memory>",
    ]);
});

test("召回记忆保留在真实模型请求中，但不进入 model.request Trace", async () => {
    const memoryFact = "用户偏好先讲结论";
    const provider = new FakeProvider([textResponse("回答")]);
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
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
    assert.doesNotMatch(JSON.stringify(traceStore.list()), new RegExp(memoryFact));
    const modelRequestStart = traceStore.list().find((event) => (
        event.name === "model.request" && event.phase === "start"
    ));
    assert.equal(
        (modelRequestStart?.data as { input: { systemPrompt: string } }).input.systemPrompt,
        "test prompt\n\n[RECALLED_MEMORY_REDACTED]",
    );
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
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager: new RecordingContextBuilder(),
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        memoryWriter: writer,
        session: createMemoryTestSession(sessionMessages),
    });

    assert.equal(await agent.run("原始问题"), "最终回答");
    assert.deepEqual(captures, [{
        userInput: "原始问题",
        assistantAnswer: "最终回答",
        sessionId: "session-memory",
    }]);
    assert.deepEqual(sessionMessages.at(-1), { role: "assistant", content: "最终回答" });

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
        queryEngine: new QueryEngine(new FakeProvider([textResponse("正常回答")])),
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
    assert.ok(traceStore.list().some((event) => (
        event.name === "memory.recall" && event.phase === "error"
    )));
    assert.ok(traceStore.list().some((event) => (
        event.name === "memory.write" && event.phase === "error"
    )));

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

test("System Prompt 约束普通聊天和诊断 Tool 的使用边界", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /普通问题/);
    assert.match(AGENT_SYSTEM_PROMPT, /同一条消息.*文件路径/);
    assert.match(AGENT_SYSTEM_PROMPT, /没有提供路径.*询问/);
    assert.match(AGENT_SYSTEM_PROMPT, /不得.*编造路径/);
});
