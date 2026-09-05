import assert from "node:assert/strict";
import test from "node:test";
import { calculateRecallAtK, summarizeAnswerCases } from "../src/evaluation/evaluate.js";

test("Recall@3 按命中的相关父文档比例计算", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["A", "B", "C"]);

    assert.equal(result.recallAtK, 1 / 3);
    assert.deepEqual(result.matchedRelevantPaths, ["A"]);
});

test("Recall@3 在全部相关父文档进入 Top-3 时为 1", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["F", "A", "E"]);

    assert.equal(result.recallAtK, 1);
    assert.deepEqual(result.matchedRelevantPaths, ["A", "E", "F"]);
});

test("重复标注和重复返回不会抬高 Recall@3", () => {
    const result = calculateRecallAtK(["A", "A", "E"], ["A", "A", "B"]);

    assert.equal(result.recallAtK, 1 / 2);
    assert.deepEqual(result.matchedRelevantPaths, ["A"]);
});

test("没有命中任何相关父文档时 Recall@3 为 0", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["B", "C", "D"]);

    assert.equal(result.recallAtK, 0);
    assert.deepEqual(result.matchedRelevantPaths, []);
});

test("完整基线分别汇总事实覆盖、引用支持和拒答准确率", () => {
    // 场景：正例和拒答例使用不同分母，不能把拒答题算进 Recall 或事实覆盖。
    const summary = summarizeAnswerCases([
        {
            shouldRefuse: false,
            status: "answered",
            factCoverage: 2 / 3,
            citationSupported: true,
            latencyMs: 100,
            usage: { generationTokens: 10, verificationTokens: 5 },
        },
        {
            shouldRefuse: true,
            status: "refused",
            factCoverage: null,
            citationSupported: null,
            latencyMs: 50,
            usage: { generationTokens: 0, verificationTokens: 0 },
        },
    ]);

    assert.equal(summary.answerCompleteness, 2 / 3);
    assert.equal(summary.citationSupportRate, 1);
    assert.equal(summary.refusalAccuracy, 1);
    assert.equal(summary.verificationFailureCount, 0);
    assert.equal(summary.averageLatencyMs, 75);
    assert.deepEqual(summary.usage, { embeddingTokens: 0, generationTokens: 10, verificationTokens: 5 });
});

test("引用验证服务失败不能冒充正确拒答", () => {
    // 场景：技术降级属于未验证，不应抬高负例拒答准确率。
    const summary = summarizeAnswerCases([
        {
            shouldRefuse: true,
            status: "refused",
            refusalReason: "citation_verification_failed",
            factCoverage: null,
            citationSupported: null,
            latencyMs: 10,
            usage: {},
        },
    ]);

    assert.equal(summary.refusalAccuracy, 0);
    assert.equal(summary.verificationFailureCount, 1);
});
