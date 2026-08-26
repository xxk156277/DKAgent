import assert from "node:assert/strict";
import test from "node:test";
import { Compressor } from "../../src/context/compressor.js";
import { ContextManager } from "../../src/context/manager.js";
import type { HistorySummaryEngine, ContextTokenCountInput, ContextTokenCounter } from "../../src/context/types.js";
import type { AgentMessage, ModelRequest, ModelResponse } from "../../src/query-engine/provider.js";

class DeterministicTokenCounter implements ContextTokenCounter {
    public count(input: ContextTokenCountInput): Promise<number> {
        const systemTokens = input.systemPrompt === undefined ? 0 : 1;
        return Promise.resolve(systemTokens + input.messages.length + input.tools.length);
    }
}

/** 每条消息按 10 Token 计数，便于精确模拟 80% 与 60% 水位。 */
class WeightedTokenCounter implements ContextTokenCounter {
    public count(input: ContextTokenCountInput): Promise<number> {
        const systemTokens = input.systemPrompt === undefined ? 0 : 10;
        return Promise.resolve(systemTokens + input.messages.length * 10 + input.tools.length * 10);
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

    assert.deepEqual(snapshot.messages, [{ role: "user", content: "当前问题" }]);
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
    const manager = new ContextManager(new WeightedTokenCounter(), new Compressor(engine));
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
    const manager = new ContextManager(new WeightedTokenCounter(), new Compressor(engine));
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
    const manager = new ContextManager(new WeightedTokenCounter(), new Compressor(engine));
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
