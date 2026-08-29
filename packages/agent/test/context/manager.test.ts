import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { Compressor } from "../../src/context/compressor.js";
import { ContextManager } from "../../src/context/manager.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import type {
    HistorySummaryEngine,
    ContextTokenCountInput,
    ContextTokenCounter,
} from "../../src/context/types.js";
import type {
    AgentMessage,
    LLMProvider,
    ModelRequest,
    ModelResponse,
    StreamEvent,
} from "../../src/query-engine/provider.js";

class TraceSummaryProvider implements LLMProvider {
    public readonly name = "summary-fake";
    public async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", content: "summary" };
        yield { type: "message_end", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    }
    public async countTokens(): Promise<number> { return 0; }
}

class AbortSummaryEngine implements HistorySummaryEngine {
    public query(): Promise<ModelResponse> {
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
}

class DeterministicTokenCounter implements ContextTokenCounter {
    public count(input: ContextTokenCountInput): Promise<number> {
        const systemTokens = input.systemPrompt === undefined ? 0 : 1;
        return Promise.resolve(
            systemTokens + input.messages.length + input.tools.length,
        );
    }
}

/** 每条消息按 10 Token 计数，便于精确模拟 80% 与 60% 水位。 */
class WeightedTokenCounter implements ContextTokenCounter {
    public count(input: ContextTokenCountInput): Promise<number> {
        const systemTokens = input.systemPrompt === undefined ? 0 : 10;
        return Promise.resolve(
            systemTokens + input.messages.length * 10 + input.tools.length * 10,
        );
    }
}

/** 可配置成功或失败的摘要模型替身。 */
class ConfigurableSummaryEngine implements HistorySummaryEngine {
    public readonly requests: ModelRequest[] = [];

    public constructor(private readonly shouldFail = false) {}

    public query(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request);
        if (this.shouldFail) {
            return Promise.reject(new Error("摘要服务不可用"));
        }

        return Promise.resolve({
            type: "text",
            content: "## Goal\n- 保留后的新摘要",
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "end_turn",
        });
    }
}

const compactionOptions = {
    enabled: true,
    triggerRatio: 0.8,
    targetRatio: 0.6,
    maxSummaryTokens: 10,
    maxToolResultChars: 100,
} as const;

function createTenMessages(): AgentMessage[] {
    return Array.from({ length: 5 }, (_, index) => [
        { role: "user" as const, content: `问题 ${index + 1}` },
        { role: "assistant" as const, content: `回答 ${index + 1}` },
    ]).flat();
}

test("未超预算时保留完整历史且不修改输入", async () => {
    const messages: AgentMessage[] = [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
    ];
    const original = structuredClone(messages);
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        systemPrompt: "系统规则",
        messages,
        tools: [],
        maxContextTokens: 10,
        reservedOutputTokens: 2,
    });

    assert.deepEqual(snapshot.messages, messages);
    assert.deepEqual(messages, original);
    assert.notEqual(snapshot.messages, messages);
});

test("超预算时从最旧的非必留消息组开始删除", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        messages: [
            { role: "user", content: "旧问题" },
            { role: "assistant", content: "旧回答" },
            { role: "user", content: "当前问题" },
        ],
        tools: [],
        maxContextTokens: 3,
        reservedOutputTokens: 1,
    });

    assert.deepEqual(snapshot.messages, [
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "当前问题" },
    ]);
});

test("裁剪时完整删除 Tool Call 和 Tool Result", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        messages: [
            { role: "user", content: "旧问题" },
            {
                role: "assistant",
                toolCalls: [{ id: "call-1", name: "read", input: {} }],
            },
            { role: "tool", toolCallId: "call-1", content: "结果" },
            { role: "user", content: "当前问题" },
        ],
        tools: [],
        maxContextTokens: 2,
        reservedOutputTokens: 1,
    });

    assert.deepEqual(snapshot.messages, [
        { role: "user", content: "当前问题" },
    ]);
});

test("必留内容超过预算时明确失败", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    await assert.rejects(
        manager.build({
            systemPrompt: "系统规则",
            messages: [{ role: "user", content: "当前问题" }],
            tools: [],
            maxContextTokens: 2,
            reservedOutputTokens: 1,
        }),
        /必留上下文超过可用 Token 预算/,
    );
});

test("拒绝非法 Token 预算", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    await assert.rejects(
        manager.build({
            messages: [],
            tools: [],
            maxContextTokens: 0,
            reservedOutputTokens: 0,
        }),
        /maxContextTokens 必须是正整数/,
    );
});

test("达到 80% 水位后摘要旧历史并尽量降低到 60%", async () => {
    const engine = new ConfigurableSummaryEngine();
    const manager = new ContextManager(
        new WeightedTokenCounter(),
        new Compressor(engine),
    );
    const messages = createTenMessages();

    const snapshot = await manager.build({
        messages,
        tools: [],
        maxContextTokens: 100,
        reservedOutputTokens: 0,
        compaction: {
            state: {
                summary: "",
                firstKeptMessageIndex: 0,
            },
            options: compactionOptions,
            summaryModel: "summary-model",
        },
    });

    assert.equal(snapshot.nextContextState?.firstKeptMessageIndex, 5);
    assert.equal(snapshot.messages.length, 5);
    assert.match(snapshot.systemPrompt ?? "", /保留后的新摘要/);
    assert.equal(engine.requests.length, 1);
});

test("连续压缩时只摘要上次边界后的新增历史并合并旧摘要", async () => {
    const engine = new ConfigurableSummaryEngine();
    const manager = new ContextManager(
        new WeightedTokenCounter(),
        new Compressor(engine),
    );
    const messages: AgentMessage[] = [
        { role: "user", content: "已经摘要的问题" },
        { role: "assistant", content: "已经摘要的回答" },
        ...createTenMessages(),
    ];

    const snapshot = await manager.build({
        messages,
        tools: [],
        maxContextTokens: 100,
        reservedOutputTokens: 0,
        compaction: {
            state: {
                summary: "## Progress\n- 旧摘要",
                firstKeptMessageIndex: 2,
            },
            options: compactionOptions,
            summaryModel: "summary-model",
        },
    });

    assert.equal(snapshot.nextContextState?.firstKeptMessageIndex, 7);
    const summaryPrompt = engine.requests[0]?.messages[0];
    assert.equal(summaryPrompt?.role, "user");
    assert.match(summaryPrompt?.content ?? "", /旧摘要/);
    assert.doesNotMatch(summaryPrompt?.content ?? "", /已经摘要的问题/);
    assert.match(summaryPrompt?.content ?? "", /问题 1/);
});

test("摘要模型失败时保留旧状态并退回整组删除", async () => {
    const engine = new ConfigurableSummaryEngine(true);
    const manager = new ContextManager(
        new WeightedTokenCounter(),
        new Compressor(engine),
    );
    const previousState = {
        summary: "旧摘要",
        firstKeptMessageIndex: 0,
    };

    const snapshot = await manager.build({
        messages: createTenMessages(),
        tools: [],
        maxContextTokens: 90,
        reservedOutputTokens: 0,
        compaction: {
            state: previousState,
            options: compactionOptions,
            summaryModel: "summary-model",
        },
    });

    assert.deepEqual(snapshot.nextContextState, previousState);
    assert.ok(snapshot.messages.length < 10);
});

test("context.build Trace 只保存 DTO，不复制 systemPrompt/messages/tools", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const manager = new ContextManager(new DeterministicTokenCounter(), new Compressor(new ConfigurableSummaryEngine()), tracer);
    await tracer.trace("agent.turn", { userInput: "context" }, async (root) => {
        await manager.build({
        systemPrompt: "secret system prompt",
        messages: [{ role: "user", content: "large private content" }],
        tools: [{ name: "tool", description: "private", parameters: { secret: "value" } }],
        maxContextTokens: 100,
        reservedOutputTokens: 10,
        });
        root.setOutput({ answer: "ok" });
    });
    const span = store.list().find((item) => item.name === "context.build")!;
    assert.deepEqual(span.input, {
        messageCount: 1, toolCount: 1, maxContextTokens: 100, reservedOutputTokens: 10,
    });
    assert.deepEqual(span.output, {
        messageCount: 1, toolCount: 1, estimatedInputTokens: 3, availableInputTokens: 90, compacted: false,
    });
    assert.doesNotMatch(JSON.stringify(span), /private|secret/);
});

test("compaction emits context.compact metrics and fallback remains successful", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const manager = new ContextManager(new WeightedTokenCounter(), new Compressor(new ConfigurableSummaryEngine(true)), tracer);
    let snapshot!: import("../../src/context/types.js").ContextSnapshot;
    await tracer.trace("agent.turn", { userInput: "compact" }, async (root) => {
        snapshot = await manager.build({
        messages: createTenMessages(), tools: [], maxContextTokens: 90, reservedOutputTokens: 0,
        compaction: { state: { summary: "old", firstKeptMessageIndex: 0 }, options: compactionOptions, summaryModel: "summary" },
        });
        root.setOutput({ answer: "ok" });
    });
    assert.ok(snapshot.messages.length < 10);
    const compact = store.list().find((item) => item.name === "context.compact")!;
    assert.equal(compact.input.messageCountBefore, 10);
    assert.equal(compact.input.decision, "summary");
    assert.equal(compact.output?.fallbackUsed, true);
    assert.equal(compact.integrity, true);
});

test("QueryEngine summary shares tracer: context.build > context.compact > model.generate", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const summaryEngine = new QueryEngine(new TraceSummaryProvider(), tracer);
    const manager = new ContextManager(
        new WeightedTokenCounter(),
        new Compressor(summaryEngine),
    );
    await tracer.trace("agent.turn", { userInput: "compact" }, async (root) => {
        await manager.build({
            messages: createTenMessages(), tools: [], maxContextTokens: 90, reservedOutputTokens: 0,
            compaction: { state: { summary: "old", firstKeptMessageIndex: 0 }, options: compactionOptions, summaryModel: "summary-model" },
        });
        root.setOutput({ answer: "ok" });
    });
    const spans = store.list();
    assert.deepEqual(spans.map((span) => span.name), ["agent.turn", "context.build", "context.compact", "model.generate"]);
    assert.equal(spans[2]?.parentSpanId, spans[1]?.spanId);
    assert.equal(spans[3]?.parentSpanId, spans[2]?.spanId);
    assert.deepEqual(spans[3]?.tokenUsage, { inputTokens: 1, outputTokens: 1 });
    assert.equal(typeof spans[3]?.durationMs, "number");
});

test("ContextManager rejects an explicit tracer different from summary QueryEngine tracer", () => {
    const summaryEngine = new QueryEngine(new TraceSummaryProvider(), new Tracer());
    assert.throws(
        () => new ContextManager(new DeterministicTokenCounter(), new Compressor(summaryEngine), new Tracer()),
        /ContextManager tracer must match Compressor tracer/,
    );
});

test("context DTO whitelists compaction fields and never copies content-shaped extras", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const manager = new ContextManager(new DeterministicTokenCounter(), new Compressor(new ConfigurableSummaryEngine()), tracer);
    await tracer.trace("agent.turn", { userInput: "dto" }, async (root) => {
        await manager.build({
            systemPrompt: "system secret",
            messages: [{ role: "user", content: "message secret" }],
            tools: [], maxContextTokens: 100, reservedOutputTokens: 10,
            compaction: {
                state: { summary: "summary secret", firstKeptMessageIndex: 0 },
                options: {
                    ...compactionOptions,
                    summary: "extra summary",
                    messages: ["extra messages"],
                    systemPrompt: "extra system",
                } as never,
                summaryModel: "summary",
            },
        });
        root.setOutput({ answer: "ok" });
    });
    const build = store.list().find((span) => span.name === "context.build")!;
    assert.deepEqual(build.input.compaction, compactionOptions);
    assert.doesNotMatch(JSON.stringify(build.input), /secret|messages|systemPrompt|summary/);
});

test("compact output/events are complete metrics, and no compact span below threshold", async () => {
    const compactStore = new MemoryTraceStore();
    const compactTracer = new Tracer(compactStore);
    const compactManager = new ContextManager(
        new WeightedTokenCounter(), new Compressor(new ConfigurableSummaryEngine(true)), compactTracer,
    );
    const previousState = { summary: "old summary", firstKeptMessageIndex: 0 };
    await compactTracer.trace("agent.turn", { userInput: "compact" }, async (root) => {
        await compactManager.build({
            messages: createTenMessages(), tools: [], maxContextTokens: 90, reservedOutputTokens: 0,
            compaction: { state: previousState, options: compactionOptions, summaryModel: "summary" },
        });
        root.setOutput({ answer: "ok" });
    });
    const compact = compactStore.list().find((span) => span.name === "context.compact")!;
    assert.deepEqual(Object.keys(compact.output ?? {}).sort(), [
        "fallbackUsed", "messageCountAfter", "messageCountBefore", "retainedMessageCount",
        "summarizedMessageCount", "tokensAfter", "tokensBefore",
    ].sort());
    assert.deepEqual(compact.output, {
        messageCountBefore: 10, messageCountAfter: 8, summarizedMessageCount: 0,
        retainedMessageCount: 8, tokensBefore: 110, tokensAfter: 90, fallbackUsed: true,
    });
    for (const span of compactStore.list().filter((item) => item.name === "context.build" || item.name === "context.compact")) {
        assert.doesNotMatch(JSON.stringify({ input: span.input, output: span.output, events: span.events }), /systemPrompt|messages|tools|groups|snapshot|old summary|message secret/);
    }

    const smallStore = new MemoryTraceStore();
    const smallTracer = new Tracer(smallStore);
    const smallManager = new ContextManager(new WeightedTokenCounter(), new Compressor(new ConfigurableSummaryEngine()), smallTracer);
    await smallTracer.trace("agent.turn", { userInput: "small" }, async (root) => {
        await smallManager.build({ messages: [{ role: "user", content: "small" }], tools: [], maxContextTokens: 100, reservedOutputTokens: 0,
            compaction: { state: previousState, options: compactionOptions, summaryModel: "summary" } });
        root.setOutput({ answer: "ok" });
    });
    assert.equal(smallStore.list().some((span) => span.name === "context.compact"), false);
});

test("Abort summary keeps old state and falls back without failing build", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const manager = new ContextManager(new WeightedTokenCounter(), new Compressor(new AbortSummaryEngine()), tracer);
    const previousState = { summary: "old summary", firstKeptMessageIndex: 0 };
    let snapshot!: import("../../src/context/types.js").ContextSnapshot;
    await tracer.trace("agent.turn", { userInput: "abort" }, async (root) => {
        snapshot = await manager.build({
            messages: createTenMessages(), tools: [], maxContextTokens: 90, reservedOutputTokens: 0,
            compaction: {
                state: previousState,
                options: compactionOptions,
                summaryModel: "summary",
                abortSignal: AbortSignal.abort(),
            },
        });
        root.setOutput({ answer: "ok" });
    });
    assert.deepEqual(snapshot.nextContextState, previousState);
    assert.ok(snapshot.messages.length < 10);
    const compact = store.list().find((span) => span.name === "context.compact")!;
    assert.equal(compact.status, "ok");
    assert.equal(compact.output?.fallbackUsed, true);
});
