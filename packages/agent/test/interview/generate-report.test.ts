import assert from "node:assert/strict";
import test from "node:test";
import type {
    ClarificationCandidate,
    CompletedQuestionAnalysis,
    ProjectFactSet,
    QuestionAnalysis,
} from "../../src/interview/analysis-types.js";
import type {
    InterviewQuestion,
    QuestionCluster,
    StructuredInterview,
} from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import {
    confidenceLabel,
    createGenerateReportTool,
} from "../../src/tools/tool-item/generate-report.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const questions: InterviewQuestion[] = [
    question("q-1", "cluster-project", "project", true, "请介绍项目", "我负责 DSL 渲染链路，" + "完整回答。".repeat(40)),
    question("q-2", "cluster-project", "project", true, "指标提升多少", "首屏耗时下降了，但是没有记住具体数字。"),
    question("q-3", "cluster-knowledge", "knowledge", true, "解释事件循环", "宏任务执行完会清空微任务。"),
    question("q-4", "cluster-procedural", "procedural", false, "还有问题吗", "没有了。"),
];

const clusters: QuestionCluster[] = [
    { id: "cluster-project", title: "低代码项目", questionIds: ["q-1", "q-2"] },
    { id: "cluster-knowledge", title: "事件循环", questionIds: ["q-3"] },
    { id: "cluster-procedural", title: "结束流程", questionIds: ["q-4"] },
];

const structuredInterview: StructuredInterview = {
    transcript: {
        source: "原始面试稿",
        turns: questions.flatMap((item, index) => [
            {
                id: `${item.id}-prompt`,
                speaker: "interviewer" as const,
                speakerLabel: "面试官",
                content: item.originalQuestion,
                sourceStart: index * 100,
                sourceEnd: index * 100 + item.originalQuestion.length,
            },
            {
                id: `${item.id}-answer`,
                speaker: "candidate" as const,
                speakerLabel: "候选人",
                content: item.originalAnswer,
                sourceStart: index * 100 + 20,
                sourceEnd: index * 100 + 20 + item.originalAnswer.length,
            },
        ]),
    },
    corrections: [],
    questions,
    clusters,
    nonQuestionTurnIds: [],
};

const analyses: QuestionAnalysis[] = [
    completed("q-1", "cluster-project", "project", 78, 0.72, [{
        factKey: "project.metric",
        question: "项目指标具体提升多少？",
        affectedQuestionIds: ["q-1"],
        impact: "medium",
    }]),
    completed("q-2", "cluster-project", "project", 66, 0.84, [{
        factKey: "project.metric",
        question: "首屏指标具体提升多少？",
        affectedQuestionIds: ["q-2"],
        impact: "high",
    }]),
    { status: "failed", questionId: "q-3", clusterId: "cluster-knowledge", error: "模型失败" },
    { status: "not_scored", questionId: "q-4", clusterId: "cluster-procedural" },
];

const projectFactSets: ProjectFactSet[] = [{
    clusterId: "cluster-project",
    facts: [],
    clarificationCandidates: [{
        factKey: "project.metric",
        question: "首屏指标具体提升多少？",
        affectedQuestionIds: ["q-1"],
        impact: "high",
    }],
}];

const validSummary = {
    levelSummary: "整体达到中级水平，项目细节仍需补强。",
    strengths: [{ text: "能够说明个人职责", questionIds: ["q-1"] }],
    coreIssues: [{ text: "缺少量化结果", questionIds: ["q-1", "q-2"] }],
    priorityImprovements: [{ text: "补充指标口径和前后对比", questionIds: ["q-2"] }],
};

function question(
    id: string,
    clusterId: string,
    questionType: InterviewQuestion["questionType"],
    scored: boolean,
    originalQuestion: string,
    originalAnswer: string,
): InterviewQuestion {
    return {
        id,
        clusterId,
        promptTurnIds: [`${id}-prompt`],
        promptSegments: [{ turnId: `${id}-prompt`, text: originalQuestion }],
        answerTurnIds: [`${id}-answer`],
        originalQuestion,
        originalAnswer,
        questionType,
        scored,
        sourceStart: 0,
        sourceEnd: originalQuestion.length + originalAnswer.length,
    };
}

function completed(
    questionId: string,
    clusterId: string,
    questionType: CompletedQuestionAnalysis["questionType"],
    score: number,
    confidence: number,
    clarificationCandidates: ClarificationCandidate[] = [],
): CompletedQuestionAnalysis {
    return {
        status: "completed",
        questionId,
        clusterId,
        questionType,
        strengths: [{
            id: `${questionId}-strength`,
            text: "职责清晰",
            impact: "能判断个人贡献",
            evidenceTurnIds: [`${questionId}-answer`],
        }],
        issues: [{
            id: `${questionId}-issue`,
            text: "结果证据不足",
            impact: "难以判断项目效果",
            evidenceTurnIds: [`${questionId}-answer`],
        }],
        improvements: [{ issueId: `${questionId}-issue`, text: "补充量化结果" }],
        dimensionScores: {
            contentQuality: score,
            depthAndEvidence: score,
            analysisAndTradeoffs: score,
            followUpHandling: questionId === "q-1" ? null : score,
            expressionQuality: score,
        },
        score,
        confidence,
        confidenceReason: confidence >= 0.8 ? "原文证据充分" : "缺少量化结果证据",
        clarificationCandidates,
    };
}

function toolContext(response: unknown): { provider: FakeTextProvider; context: ToolContext } {
    const content = typeof response === "string" ? response : JSON.stringify(response);
    const provider = new FakeTextProvider(content);
    return {
        provider,
        context: {
            queryEngine: new QueryEngine(provider),
            abortSignal: new AbortController().signal,
        },
    };
}

function baseInput(overrides: Record<string, unknown> = {}) {
    return {
        structuredInterview,
        analyses,
        projectFactSets,
        stage: "provisional" as const,
        ...overrides,
    };
}

test("暂定报告展示暂定总分、覆盖率和完整问题顺序", async () => {
    const { provider, context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(baseInput(), context);

    assert.equal(result.success, true);
    assert.equal(result.data?.report.stage, "provisional");
    assert.match(result.data?.report.notice ?? "", /暂定总分.*可能调整/);
    assert.equal(result.data?.report.questions.length, structuredInterview.questions.length);
    assert.deepEqual(result.data?.report.questions.map((item) => item.questionId), ["q-1", "q-2", "q-3", "q-4"]);
    assert.equal(result.data?.report.questions[0]?.label, "低代码项目 / 项目题");
    assert.match(result.data?.markdown ?? "", /已分析：2\/3/);
    assert.match(result.data?.markdown ?? "", new RegExp(questions[0]!.originalAnswer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const firstQuestion = result.data!.markdown.split("### Q1\n")[1]!.split("### Q2\n")[0]!;
    assert.ok(firstQuestion.indexOf("原问题") < firstQuestion.indexOf("原回答"));
    assert.ok(firstQuestion.indexOf("原回答") < firstQuestion.indexOf("标签："));
    assert.ok(firstQuestion.indexOf("标签：") < firstQuestion.indexOf("\n\n问题："));
    assert.ok(firstQuestion.indexOf("\n\n问题：") < firstQuestion.indexOf("改进方向："));
    assert.equal(provider.request?.model, "fake-model");
});

test("待确认项按事实键合并、high 优先、影响题数倒序且最多五条", async () => {
    const extras: ClarificationCandidate[] = [
        clarification("high-many", "high", ["q-1", "q-2", "q-3"]),
        clarification("high-one", "high", ["q-1"]),
        clarification("medium-many", "medium", ["q-1", "q-2"]),
        clarification("medium-one", "medium", ["q-1"]),
        clarification("medium-last", "medium", ["q-2"]),
        clarification("low-ignored", "low", ["q-1", "q-2", "q-3"]),
    ];
    const inputAnalyses = analyses.map((item) => item.status === "completed"
        ? { ...item, clarificationCandidates: [...item.clarificationCandidates, ...extras] }
        : item);
    const { context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(
        baseInput({ analyses: inputAnalyses }),
        context,
    );

    assert.equal(result.success, true);
    const pending = result.data?.report.pendingClarifications ?? [];
    assert.equal(pending.length, 5);
    assert.equal(new Set(pending.map((item) => item.factKey)).size, pending.length);
    assert.deepEqual(pending.slice(0, 3).map((item) => item.factKey), [
        "high-many",
        "project.metric",
        "high-one",
    ]);
    assert.deepEqual(pending.find((item) => item.factKey === "project.metric")?.affectedQuestionIds, ["q-1", "q-2"]);
    assert.ok(pending.every((item) => item.impact !== "low"));
});

test("最终报告存在 high 待确认项时拒绝生成且不调用模型", async () => {
    const { provider, context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(
        baseInput({ stage: "final" }),
        context,
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
    assert.equal(provider.request, undefined);
});

test("总结引用未知问题时降级但保留分数和问题列表", async () => {
    const { context } = toolContext({
        ...validSummary,
        coreIssues: [{ text: "无来源结论", questionIds: ["q-unknown"] }],
    });
    const result = await createGenerateReportTool("fake-model").execute(baseInput(), context);

    assert.equal(result.success, true);
    assert.equal(result.data?.report.summaryStatus, "failed");
    assert.ok(result.data?.report.score.totalScore !== null);
    assert.equal(result.data?.report.questions.length, structuredInterview.questions.length);
    assert.equal(result.data?.report.levelSummary, "");
    assert.deepEqual(result.data?.report.strengths, []);
    assert.deepEqual(result.data?.report.coreIssues, []);
    assert.deepEqual(result.data?.report.priorityImprovements, []);
});

test("总结模型异常时降级但仍返回确定性报告", async () => {
    const { context } = toolContext("not-json");
    const result = await createGenerateReportTool("fake-model").execute(baseInput(), context);

    assert.equal(result.success, true);
    assert.equal(result.data?.report.summaryStatus, "failed");
    assert.equal(result.data?.report.score.coverage.analyzed, 2);
    assert.equal(result.data?.report.questions.length, 4);
});

test("汇总成功但文字条目为空时不误报汇总失败", async () => {
    const { context } = toolContext({
        levelSummary: "证据有限，暂不提炼共性结论。",
        strengths: [],
        coreIssues: [],
        priorityImprovements: [],
    });
    const result = await createGenerateReportTool("fake-model").execute(baseInput(), context);

    assert.equal(result.data?.report.summaryStatus, "completed");
    assert.doesNotMatch(result.data?.markdown ?? "", /汇总失败/);
});

test("流程题和失败题保留但不显示分数", async () => {
    const { context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(baseInput(), context);
    const procedural = result.data?.report.questions.find((item) => item.status === "not_scored");
    const failed = result.data?.report.questions.find((item) => item.status === "failed");

    assert.equal(procedural?.score, null);
    assert.equal(failed?.score, null);
    assert.match(result.data?.markdown ?? "", /分数：不参与评分/);
    assert.match(result.data?.markdown ?? "", /分数：分析失败/);
});

test("拒绝未知和重复的逐题分析 ID", async () => {
    const tool = createGenerateReportTool("fake-model");
    for (const invalidAnalyses of [
        [...analyses, completed("q-unknown", "cluster-project", "project", 70, 0.8)],
        [...analyses, analyses[0]!],
    ]) {
        const { provider, context } = toolContext(validSummary);
        const result = await tool.execute(baseInput({ analyses: invalidAnalyses }), context);
        assert.equal(result.success, false);
        assert.equal(result.error?.code, "input_error");
        assert.equal(provider.request, undefined);
    }
});

test("拒绝逐题分析引用未知原文轮次", async () => {
    const first = analyses[0]!;
    assert.equal(first.status, "completed");
    if (first.status !== "completed") return;
    const invalidAnalyses: QuestionAnalysis[] = [{
        ...first,
        issues: [{ ...first.issues[0]!, evidenceTurnIds: ["turn-unknown"] }],
    }, ...analyses.slice(1)];
    const { provider, context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(
        baseInput({ analyses: invalidAnalyses }),
        context,
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
    assert.equal(provider.request, undefined);
});

test("拒绝可在问题簇平均中相互抵消的越界维度分", async () => {
    const invalidAnalyses = analyses.map((analysis) => {
        if (analysis.status !== "completed") return analysis;
        return {
            ...analysis,
            dimensionScores: {
                ...analysis.dimensionScores,
                contentQuality: analysis.questionId === "q-1" ? 200 : -100,
            },
        };
    });
    const { provider, context } = toolContext(validSummary);
    const result = await createGenerateReportTool("fake-model").execute(
        baseInput({ analyses: invalidAnalyses }),
        context,
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
    assert.equal(provider.request, undefined);
});

test("置信度边界按固定阈值显示", () => {
    assert.equal(confidenceLabel(0.8), "高");
    assert.equal(confidenceLabel(0.55), "中");
    assert.equal(confidenceLabel(0.54), "低");
});

function clarification(
    factKey: string,
    impact: ClarificationCandidate["impact"],
    affectedQuestionIds: string[],
): ClarificationCandidate {
    return {
        factKey,
        question: `请补充 ${factKey}`,
        affectedQuestionIds,
        impact,
    };
}
