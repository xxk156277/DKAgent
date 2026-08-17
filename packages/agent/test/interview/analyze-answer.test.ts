import assert from "node:assert/strict";
import test from "node:test";
import type {
    ExpressionAnalysis,
    ProjectFactSet,
} from "../../src/interview/analysis-types.js";
import { QUESTION_RUBRICS } from "../../src/interview/rubrics.js";
import type {
    InterviewQuestion,
    QuestionCluster,
} from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import {
    createAnalyzeAnswerTool,
    type AnalyzeAnswerInput,
} from "../../src/tools/tool-item/analyze-answer.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const cluster: QuestionCluster = {
    id: "cluster-project",
    title: "低代码项目",
    questionIds: ["q-project", "q-follow-up"],
};

const projectQuestion = question({
    id: "q-project",
    questionType: "project",
    promptTurnIds: ["turn-p1"],
    answerTurnIds: ["turn-a1"],
});
const followUpQuestion = question({
    id: "q-follow-up",
    questionType: "project",
    promptTurnIds: ["turn-p2"],
    answerTurnIds: ["turn-a2"],
});

const expression: ExpressionAnalysis = {
    questionId: projectQuestion.id,
    stats: {
        fillerWords: [],
        fillerCount: 0,
        adjacentRepetitionCount: 0,
        characterCount: 20,
        sentenceCount: 1,
        longSentenceCount: 0,
    },
    judgementStatus: "completed",
    impact: "none",
    detail: "表达清楚",
    evidenceQuotes: [],
    score: 72,
    confidence: 0.9,
};

const projectFacts: ProjectFactSet = {
    clusterId: cluster.id,
    facts: [{
        key: "project.role",
        category: "responsibility",
        value: "负责 DSL 渲染链路",
        status: "stated",
        evidenceTurnIds: ["turn-a1"],
        evidenceQuote: "这是候选人的回答",
        affectedQuestionIds: [projectQuestion.id],
        clarificationQuestion: null,
        impact: "high",
    }],
    clarificationCandidates: [],
};

const validProjectResponse = {
    strengths: [{
        id: "strength-1",
        text: "职责明确",
        impact: "便于判断个人贡献",
        evidenceTurnIds: ["turn-a1"],
    }],
    issues: [{
        id: "issue-1",
        text: "结果证据不足",
        impact: "无法判断改造效果",
        evidenceTurnIds: ["turn-p1", "turn-a1"],
    }],
    improvements: [{ issueId: "issue-1", text: "补充前后指标与口径" }],
    dimensions: {
        contentQuality: 80,
        depthAndEvidence: 60,
        analysisAndTradeoffs: 70,
        followUpHandling: null,
    },
    confidence: 0.9,
    confidenceReason: "回答和项目事实均有原文证据",
    clarificationCandidates: [],
};

function question(input: {
    id: string;
    questionType: InterviewQuestion["questionType"];
    promptTurnIds?: string[];
    answerTurnIds?: string[];
    clusterId?: string;
}): InterviewQuestion {
    const promptTurnIds = input.promptTurnIds ?? [`${input.id}-prompt`];
    return {
        id: input.id,
        clusterId: input.clusterId ?? cluster.id,
        promptTurnIds,
        promptSegments: promptTurnIds.map((turnId) => ({ turnId, text: "问题" })),
        answerTurnIds: input.answerTurnIds ?? [`${input.id}-answer`],
        originalQuestion: "请介绍你的回答",
        originalAnswer: "这是候选人的回答",
        questionType: input.questionType,
        scored: input.questionType !== "procedural",
        sourceStart: 0,
        sourceEnd: 10,
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

function projectInput(overrides: Partial<AnalyzeAnswerInput> = {}): AnalyzeAnswerInput {
    return {
        question: projectQuestion,
        cluster,
        clusterQuestions: [projectQuestion, followUpQuestion],
        projectFacts,
        expression,
        references: [],
        ...overrides,
    };
}

test("题型 Rubric 只声明各题型适用的语义维度", () => {
    assert.deepEqual(QUESTION_RUBRICS, {
        project: {
            prompt: "评价项目背景、本人职责、决策依据、实施细节、结果证据和追问一致性，不与标准答案比较。",
            applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
        },
        knowledge: {
            prompt: "评价技术事实、关键知识点和原理深度；只有提供参考资料时才据其核验。",
            applicableDimensions: ["contentQuality", "depthAndEvidence"],
        },
        open: {
            prompt: "评价问题澄清、约束、拆解、权衡、风险和验证。",
            applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
        },
        behavior: {
            prompt: "评价情境、个人行动、协作方式、结果和复盘。",
            applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
        },
        coding: {
            prompt: "评价思路、实际产出、样例验证、边界和复杂度。",
            applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
        },
    });
});

test("项目题不依赖参考答案，并组合表达质量分", async () => {
    const { provider, context } = toolContext(validProjectResponse);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput({ references: ["与候选人回答矛盾的标准答案"] }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    if (result.data?.status !== "completed") return;
    assert.equal(result.data.dimensionScores.expressionQuality, 72);
    assert.equal(result.data.dimensionScores.followUpHandling, null);
    assert.equal(result.data.score, 70);
    const requestContent = provider.request?.messages[0];
    assert.equal(requestContent?.role, "user");
    if (requestContent?.role === "user") {
        assert.doesNotMatch(requestContent.content, /标准答案/);
    }
    assert.match(provider.request?.systemPrompt ?? "", /不与标准答案比较/);
});

test("项目事实提取失败时置信度上限为 0.54", async () => {
    const { context } = toolContext({ ...validProjectResponse, confidence: 0.9 });
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput({ projectFacts: null }),
        context,
    );

    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.confidence, 0.54);
    }
});

test("相关项目事实仍为 inferred 时置信度固定封顶为 0.79", async () => {
    const inferredFacts: ProjectFactSet = {
        ...projectFacts,
        facts: projectFacts.facts.map((fact) => ({
            ...fact,
            status: "inferred" as const,
            clarificationQuestion: "你是否独立负责该链路？",
        })),
    };
    const { context } = toolContext({ ...validProjectResponse, confidence: 0.95 });

    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput({ projectFacts: inferredFacts }),
        context,
    );

    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.confidence, 0.79);
    }
});

test("知识题没有参考资料时置信度上限为 0.79 且权衡维度不适用", async () => {
    const knowledgeQuestion = question({ id: "q-knowledge", questionType: "knowledge" });
    const knowledgeCluster = { ...cluster, questionIds: [knowledgeQuestion.id] };
    const response = {
        ...validProjectResponse,
        strengths: [],
        issues: [],
        improvements: [],
        dimensions: {
            contentQuality: 85,
            depthAndEvidence: 75,
            analysisAndTradeoffs: null,
            followUpHandling: null,
        },
        confidence: 0.95,
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute({
        question: knowledgeQuestion,
        cluster: knowledgeCluster,
        clusterQuestions: [knowledgeQuestion],
        projectFacts: null,
        expression: { ...expression, questionId: knowledgeQuestion.id },
        references: [],
    }, context);

    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.confidence, 0.79);
        assert.equal(result.data.dimensionScores.analysisAndTradeoffs, null);
    }
});

test("知识题忽略空字符串和纯空白参考资料", async () => {
    const knowledgeQuestion = question({ id: "q-knowledge", questionType: "knowledge" });
    const knowledgeCluster = { ...cluster, questionIds: [knowledgeQuestion.id] };
    const response = {
        ...validProjectResponse,
        strengths: [],
        issues: [],
        improvements: [],
        dimensions: {
            contentQuality: 85,
            depthAndEvidence: 75,
            analysisAndTradeoffs: null,
            followUpHandling: null,
        },
        confidence: 0.95,
    };

    for (const references of [[""], ["   "]]) {
        const { provider, context } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute({
            question: knowledgeQuestion,
            cluster: knowledgeCluster,
            clusterQuestions: [knowledgeQuestion],
            projectFacts: null,
            expression: { ...expression, questionId: knowledgeQuestion.id },
            references,
        }, context);

        assert.equal(result.data?.status, "completed");
        if (result.data?.status === "completed") {
            assert.equal(result.data.confidence, 0.79);
        }
        const requestContent = provider.request?.messages[0];
        assert.equal(requestContent?.role, "user");
        if (requestContent?.role === "user") {
            assert.equal("references" in JSON.parse(requestContent.content), false);
        }
    }
});

test("知识题有参考资料时才把资料提供给模型", async () => {
    const knowledgeQuestion = question({ id: "q-knowledge", questionType: "knowledge" });
    const knowledgeCluster = { ...cluster, questionIds: [knowledgeQuestion.id] };
    const response = {
        ...validProjectResponse,
        strengths: [],
        issues: [],
        improvements: [],
        dimensions: {
            contentQuality: 85,
            depthAndEvidence: 75,
            analysisAndTradeoffs: null,
            followUpHandling: null,
        },
    };
    const { provider, context } = toolContext(response);
    await createAnalyzeAnswerTool("fake-model").execute({
        question: knowledgeQuestion,
        cluster: knowledgeCluster,
        clusterQuestions: [knowledgeQuestion],
        projectFacts: null,
        expression: { ...expression, questionId: knowledgeQuestion.id },
        references: ["  事件循环先执行同步任务  "],
    }, context);

    const requestContent = provider.request?.messages[0];
    assert.equal(requestContent?.role, "user");
    if (requestContent?.role === "user") {
        assert.deepEqual(JSON.parse(requestContent.content).references, [
            "事件循环先执行同步任务",
        ]);
    }
});

test("流程题不调用 LLM 并直接返回 not_scored", async () => {
    const proceduralQuestion = question({ id: "q-procedural", questionType: "procedural" });
    const proceduralCluster = { ...cluster, questionIds: [proceduralQuestion.id] };
    const provider = new FakeTextProvider("不应读取");
    const context: ToolContext = {
        queryEngine: new QueryEngine(provider),
        abortSignal: new AbortController().signal,
    };
    const result = await createAnalyzeAnswerTool("fake-model").execute({
        question: proceduralQuestion,
        cluster: proceduralCluster,
        clusterQuestions: [proceduralQuestion],
        projectFacts: null,
        expression: { ...expression, questionId: proceduralQuestion.id },
        references: [],
    }, context);

    assert.deepEqual(result.data, {
        status: "not_scored",
        questionId: proceduralQuestion.id,
        clusterId: proceduralQuestion.clusterId,
    });
    assert.equal(provider.request, undefined);
});

test("拒绝不存在的证据轮次", async () => {
    const response = {
        ...validProjectResponse,
        issues: [{
            ...validProjectResponse.issues[0],
            evidenceTurnIds: ["turn-unknown"],
        }],
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(),
        context,
    );

    assert.equal(result.success, false);
});

test("strength 和 issue 都必须至少引用一个当前问题轮次", async () => {
    const invalidResponses = [
        {
            ...validProjectResponse,
            strengths: [{
                ...validProjectResponse.strengths[0],
                evidenceTurnIds: [],
            }],
        },
        {
            ...validProjectResponse,
            issues: [{
                ...validProjectResponse.issues[0],
                evidenceTurnIds: [],
            }],
        },
    ];

    for (const response of invalidResponses) {
        const { context } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute(
            projectInput(),
            context,
        );

        assert.equal(result.success, false);
    }
});

test("拒绝题型不适用的维度分", async () => {
    const knowledgeQuestion = question({ id: "q-knowledge", questionType: "knowledge" });
    const knowledgeCluster = { ...cluster, questionIds: [knowledgeQuestion.id] };
    const response = {
        ...validProjectResponse,
        strengths: [],
        issues: [],
        improvements: [],
        dimensions: {
            contentQuality: 80,
            depthAndEvidence: 70,
            analysisAndTradeoffs: 60,
            followUpHandling: null,
        },
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute({
        question: knowledgeQuestion,
        cluster: knowledgeCluster,
        clusterQuestions: [knowledgeQuestion],
        projectFacts: null,
        expression: { ...expression, questionId: knowledgeQuestion.id },
        references: [],
    }, context);

    assert.equal(result.success, false);
});

test("簇中追问才允许 followUpHandling 分数", async () => {
    const response = {
        ...validProjectResponse,
        strengths: [],
        issues: [],
        improvements: [],
        dimensions: {
            ...validProjectResponse.dimensions,
            followUpHandling: 84,
        },
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput({
            question: followUpQuestion,
            expression: { ...expression, questionId: followUpQuestion.id },
        }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.dimensionScores.followUpHandling, 84);
    }
});

test("追问位置只由 cluster.questionIds 决定，不依赖 clusterQuestions 数组顺序", async () => {
    const { context } = toolContext(validProjectResponse);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput({ clusterQuestions: [followUpQuestion, projectQuestion] }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.dimensionScores.followUpHandling, null);
    }
});

test("每个 issue 必须恰好对应一个 improvement", async () => {
    const responses = [
        { ...validProjectResponse, improvements: [] },
        {
            ...validProjectResponse,
            improvements: [
                validProjectResponse.improvements[0],
                validProjectResponse.improvements[0],
            ],
        },
        {
            ...validProjectResponse,
            improvements: [{ issueId: "issue-unknown", text: "无对应问题" }],
        },
    ];

    for (const response of responses) {
        const { context } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute(
            projectInput(),
            context,
        );
        assert.equal(result.success, false);
    }
});

test("clarification 只能引用当前簇 questionId", async () => {
    const response = {
        ...validProjectResponse,
        clarificationCandidates: [{
            factKey: "project.metric",
            question: "指标口径是什么？",
            affectedQuestionIds: ["q-outside"],
            impact: "high",
        }],
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(),
        context,
    );

    assert.equal(result.success, false);
});
