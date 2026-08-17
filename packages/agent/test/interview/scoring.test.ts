import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuestionScore, scoreInterview } from "../../src/interview/scoring.js";
import type { CompletedQuestionAnalysis } from "../../src/interview/analysis-types.js";
import type { InterviewQuestion, QuestionCluster } from "../../src/interview/types.js";

const questions = [
    { id: "q-1", clusterId: "c-1", scored: true },
    { id: "q-2", clusterId: "c-1", scored: true },
    { id: "q-3", clusterId: "c-2", scored: true },
    { id: "q-4", clusterId: "c-3", scored: false },
] as InterviewQuestion[];

const clusters: QuestionCluster[] = [
    { id: "c-1", title: "项目", questionIds: ["q-1", "q-2"] },
    { id: "c-2", title: "知识", questionIds: ["q-3"] },
    { id: "c-3", title: "流程", questionIds: ["q-4"] },
];

function completed(
    questionId: string,
    contentQuality: number,
): CompletedQuestionAnalysis {
    return {
        status: "completed",
        questionId,
        clusterId: questionId === "q-3" ? "c-2" : "c-1",
        questionType: "project",
        strengths: [],
        issues: [],
        improvements: [],
        dimensionScores: {
            contentQuality,
            depthAndEvidence: null,
            analysisAndTradeoffs: null,
            followUpHandling: null,
            expressionQuality: null,
        },
        score: contentQuality,
        confidence: 0.8,
        confidenceReason: "证据充分",
        clarificationCandidates: [],
    };
}

test("单题只按适用维度重新归一化", () => {
    assert.equal(calculateQuestionScore({
        contentQuality: 80,
        depthAndEvidence: 60,
        analysisAndTradeoffs: null,
        followUpHandling: null,
        expressionQuality: null,
    }), 70);
});

test("先簇内平均再让问题簇等权", () => {
    const result = scoreInterview({
        questions,
        clusters,
        analyses: [completed("q-1", 40), completed("q-2", 80), completed("q-3", 100)],
    });

    assert.equal(result.clusterScores[0]?.dimensions.contentQuality, 60);
    assert.equal(result.dimensions.contentQuality, 80);
    assert.equal(result.totalScore, 80);
    assert.deepEqual(result.coverage, { analyzed: 3, expected: 3 });
});

test("失败题和流程题不按零分进入分母", () => {
    const result = scoreInterview({
        questions,
        clusters,
        analyses: [
            completed("q-1", 80),
            { status: "failed", questionId: "q-2", clusterId: "c-1", error: "模型失败" },
            completed("q-3", 100),
            { status: "not_scored", questionId: "q-4", clusterId: "c-3" },
        ],
    });

    assert.equal(result.totalScore, 90);
    assert.deepEqual(result.coverage, { analyzed: 2, expected: 3 });
});

test("没有任何可评分维度时拒绝生成分数", () => {
    assert.throws(
        () => scoreInterview({
            questions,
            clusters,
            analyses: [{
                ...completed("q-1", 80),
                dimensionScores: {
                    contentQuality: null,
                    depthAndEvidence: null,
                    analysisAndTradeoffs: null,
                    followUpHandling: null,
                    expressionQuality: null,
                },
                score: null,
            }],
        }),
        /没有可评分维度/,
    );
});
