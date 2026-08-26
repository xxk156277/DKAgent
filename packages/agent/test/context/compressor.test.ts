import assert from "node:assert/strict";
import test from "node:test";
import { Compressor } from "../../src/context/compressor.js";
import type { HistorySummaryEngine } from "../../src/context/types.js";
import type { ModelRequest, ModelResponse } from "../../src/query-engine/provider.js";

/** 测试用摘要引擎：记录请求并返回固定摘要。 */
class FakeSummaryEngine implements HistorySummaryEngine {
    public readonly requests: ModelRequest[] = [];

    public query(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request);
        return Promise.resolve({
            type: "text",
            content: "## Goal\n- 继续实现 Context V2",
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "end_turn",
        });
    }
}

test("普通文本超过局部 Token 上限时按比例截断并保留标记", () => {
    const compressor = new Compressor(new FakeSummaryEngine());
    const original = "a".repeat(100);

    const compressed = compressor.truncate(original, 10);

    assert.ok(compressed.length < original.length);
    assert.match(compressed, /\[\.\.\. 已截断\]$/);
});

test("Tool JSON 压缩时保留字段并只保留数组前三项", () => {
    const compressor = new Compressor(new FakeSummaryEngine());
    const output = JSON.stringify({
        source: "interview.md",
        questions: Array.from({ length: 5 }, (_, index) => ({
            index,
            answer: "答".repeat(120),
        })),
    });

    // 该预算足以容纳“前三项 + 每个长字符串 100 字符”的合法 JSON。
    const compressed = compressor.compressToolOutput(output, 600);
    const parsed = JSON.parse(compressed) as {
        source: string;
        questions: Array<{ index: number; answer: string }>;
    };

    assert.equal(parsed.source, "interview.md");
    assert.equal(parsed.questions.length, 3);
    assert.match(parsed.questions[0]?.answer ?? "", /\.\.\.$/);
});

test("历史序列化会截断摘要请求中的 Tool Result 但不修改原消息", () => {
    const compressor = new Compressor(new FakeSummaryEngine());
    const messages = [
        {
            role: "tool" as const,
            toolCallId: "call-1",
            content: "x".repeat(20),
        },
    ];
    const original = structuredClone(messages);

    const serialized = compressor.serializeHistory(messages, 5);

    assert.match(serialized, /\[Tool result call-1\]: xxxxx/);
    assert.match(serialized, /省略 15 个字符/);
    assert.deepEqual(messages, original);
});

test("历史摘要请求包含已有摘要、新增历史和结构化系统规则", async () => {
    const engine = new FakeSummaryEngine();
    const compressor = new Compressor(engine);

    const summary = await compressor.summarizeHistory({
        existingSummary: "## Progress\n- 已完成 Context V1",
        messages: [{ role: "user", content: "继续实现压缩" }],
        model: "summary-model",
        maxTokens: 500,
        maxToolResultChars: 2_000,
    });

    assert.match(summary, /继续实现 Context V2/);
    assert.equal(engine.requests[0]?.model, "summary-model");
    assert.equal(engine.requests[0]?.maxTokens, 500);
    assert.match(engine.requests[0]?.systemPrompt ?? "", /## Key Decisions/);

    const prompt = engine.requests[0]?.messages[0];
    assert.equal(prompt?.role, "user");
    assert.match(prompt?.content ?? "", /已完成 Context V1/);
    assert.match(prompt?.content ?? "", /\[User\]: 继续实现压缩/);
});
