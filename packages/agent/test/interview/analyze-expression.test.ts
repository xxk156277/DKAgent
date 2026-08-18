import assert from "node:assert/strict";
import test from "node:test";
import { collectExpressionStats } from "../../src/interview/expression-statistics.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createAnalyzeExpressionTool } from "../../src/tools/tool-item/analyze-expression.js";
import { FakeTextProvider } from "./fake-provider.js";

function context(content: string) {
    const provider = new FakeTextProvider(content);
    return {
        provider,
        context: {
            queryEngine: new QueryEngine(provider),
            abortSignal: new AbortController().signal,
        },
    };
}

test("确定性统计保留口头语、重复和长句", () => {
    const longSentence = "这是一段".repeat(31) + "。";
    const result = collectExpressionStats(`嗯，然后然后开始处理。呃，${longSentence}`);

    assert.deepEqual(result.fillerWords, [
        { word: "嗯", count: 1 },
        { word: "呃", count: 1 },
        { word: "然后", count: 2 },
    ]);
    assert.equal(result.fillerCount, 4);
    assert.ok(result.adjacentRepetitionCount >= 1);
    assert.equal(result.characterCount, 138);
    assert.equal(result.sentenceCount, 2);
    assert.equal(result.longSentenceCount, 1);
});

test("LLM 只能基于原回答判断理解影响", async () => {
    const response = JSON.stringify({
        impact: "slight",
        detail: "重复连接词使句子略显拖沓",
        evidenceQuotes: ["然后然后"],
        score: 76,
        confidence: 0.86,
    });
    const { provider, context: toolContext } = context(response);
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "嗯，然后然后我完成了灰度。" },
        toolContext,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.judgementStatus, "completed");
    assert.equal(result.data?.score, 76);
    assert.match(provider.request?.systemPrompt ?? "", /不得评价.*语速.*音量/);
    const userMessage = provider.request?.messages[0];
    assert.equal(userMessage?.role, "user");
    if (userMessage?.role === "user") {
        assert.deepEqual(JSON.parse(userMessage.content), {
            answer: "嗯，然后然后我完成了灰度。",
        });
    }
});

test("LLM 输出失败时保留统计并降级为 unknown", async () => {
    const { context: toolContext } = context("not-json");
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "嗯，我负责灰度。" },
        toolContext,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.judgementStatus, "failed");
    assert.equal(result.data?.impact, "unknown");
    assert.equal(result.data?.score, null);
    assert.equal(result.data?.confidence, 0);
    assert.equal(result.data?.stats.fillerCount, 1);
});

test("拒绝模型返回不在原回答中的证据片段", async () => {
    const response = JSON.stringify({
        impact: "significant",
        detail: "无法理解",
        evidenceQuotes: ["原文不存在"],
        score: 20,
        confidence: 0.9,
    });
    const { context: toolContext } = context(response);
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "我负责灰度。" },
        toolContext,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.judgementStatus, "failed");
    assert.equal(result.data?.impact, "unknown");
    assert.equal(result.data?.score, null);
});
