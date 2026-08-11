import assert from "node:assert/strict";
import test from "node:test";
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
    RuntimeEvent,
    RuntimeEventSink,
} from "../../src/runtime/events.js";
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
    runtimeEventSink?: RuntimeEventSink,
): AgentLoop {
    return new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: registry,
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        systemPrompt: "test prompt",
        ...(runtimeEventSink === undefined ? {} : { runtimeEventSink }),
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
            estimatedInputTokens: latestMessage ? 1 : 0,
            availableInputTokens:
                input.maxContextTokens - input.reservedOutputTokens,
            droppedMessageCount: Math.max(input.messages.length - 1, 0),
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
    const contextEvents: RuntimeEvent[] = [];
    const contextSink: RuntimeEventSink = {
        emit: (event) => contextEvents.push(event),
    };
    const agent = createAgent(
        provider,
        new ToolRegistry(),
        new LatestMessageContextBuilder(),
        contextSink,
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
    const secondAfter = contextEvents.filter(
        (event) => event.type === "context.after",
    ).at(-1);
    assert.equal(
        (secondAfter?.payload as ContextSnapshot).droppedMessageCount,
        2,
    );
});

test("诊断意图产生 Tool Call 后，将结果回传模型", async () => {
    const provider = new FakeProvider([
        [
            { type: "tool_call_start", index: 0, id: "call-1", name: "split_qa_pairs" },
            {
                type: "tool_call_delta",
                index: 0,
                argumentsDelta: '{"transcriptPath":"test/test-short.md"}',
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
            assert.equal(input.transcriptPath, "test/test-short.md");
            return { success: true, data: { totalQuestions: 1 } };
        },
    };
    const registry = new ToolRegistry();
    registry.register(fakeSplitTool);
    const toolEvents: RuntimeEvent[] = [];
    const toolSink: RuntimeEventSink = {
        emit: (event) => toolEvents.push(event),
    };
    const agent = createAgent(
        provider,
        registry,
        new ContextManager(new ProviderTokenCounter(provider)),
        toolSink,
    );

    const answer = await agent.run("帮我诊断 test/test-short.md");

    assert.equal(answer, "已拆分 1 组问答");
    assert.equal(executeCount, 1);
    assert.deepEqual(provider.requests[1]?.messages.map((message) => message.role), [
        "user",
        "assistant",
        "tool",
    ]);
    assert.deepEqual(toolEvents.map((event) => event.type), [
        "turn.start", "context.before", "context.after", "model.response",
        "tool.call", "tool.result", "context.before", "context.after",
        "model.response", "turn.end",
    ]);
});

test("System Prompt 约束普通聊天和诊断 Tool 的使用边界", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /普通问题/);
    assert.match(AGENT_SYSTEM_PROMPT, /同一条消息.*文件路径/);
    assert.match(AGENT_SYSTEM_PROMPT, /没有提供路径.*询问/);
    assert.match(AGENT_SYSTEM_PROMPT, /不得.*编造路径/);
});
