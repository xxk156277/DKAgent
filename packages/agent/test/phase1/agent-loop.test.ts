import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { AgentLoop } from "../../src/agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../../src/agent/prompt.js";
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
    LLMProvider,
    StreamEvent,
    StreamParams,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool } from "../../src/tools/types.js";

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

function textResponse(content: string): StreamEvent[] {
    return [
        { type: "text_delta", content },
        { type: "message_end", usage, stopReason: "end_turn" },
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

test("System Prompt 约束普通聊天和诊断 Tool 的使用边界", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /普通问题/);
    assert.match(AGENT_SYSTEM_PROMPT, /同一条消息.*文件路径/);
    assert.match(AGENT_SYSTEM_PROMPT, /没有提供路径.*询问/);
    assert.match(AGENT_SYSTEM_PROMPT, /不得.*编造路径/);
});
