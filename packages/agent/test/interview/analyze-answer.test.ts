import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";
import type { QuestionAnalysis } from "../../src/interview/analysis-types.js";
import type { QuestionAnalysisArtifact } from "../../src/interview/artifact-payloads.js";
import { collectExpressionStats } from "../../src/interview/expression-statistics.js";
import { QUESTION_RUBRICS } from "../../src/interview/rubrics.js";
import type { InterviewQuestion, QuestionCluster, StructuredInterview } from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createAnalyzeAnswerTool, type AnalyzeAnswerInput } from "../../src/tools/tool-item/analyze-answer.js";
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

const expressionStats = collectExpressionStats(projectQuestion.originalAnswer);

// const projectFacts: ProjectFactSet = {
//     clusterId: cluster.id,
//     facts: [{
//         key: "cluster-project.role",
//         category: "responsibility",
//         value: "负责 DSL 渲染链路",
//         status: "stated",
//         evidenceTurnIds: ["turn-a1"],
//         evidenceQuote: "这是候选人的回答",
//         affectedQuestionIds: [projectQuestion.id],
//         clarificationQuestion: null,
//         impact: "high",
//     }],
//     clarificationCandidates: [],
// };

const validProjectResponse = {
    strengths: [
        {
            id: "strength-1",
            text: "职责明确",
            impact: "便于判断个人贡献",
            evidenceTurnIds: ["turn-a1"],
        },
    ],
    issues: [
        {
            id: "issue-1",
            text: "结果证据不足",
            impact: "无法判断改造效果",
            evidenceTurnIds: ["turn-p1", "turn-a1"],
        },
    ],
    improvements: [{ issueId: "issue-1", text: "补充前后指标与口径" }],
    dimensions: {
        contentQuality: 80,
        depthAndEvidence: 60,
        analysisAndTradeoffs: 70,
        followUpHandling: null,
        expressionQuality: 72,
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

function toolContext(response: unknown): {
    provider: FakeTextProvider;
    context: ToolContext;
    artifacts: InMemoryArtifactStore;
} {
    const content = typeof response === "string" ? response : JSON.stringify(response);
    const provider = new FakeTextProvider(content);
    const artifacts = new InMemoryArtifactStore();
    return {
        provider,
        artifacts,
        context: {
            queryEngine: new QueryEngine(provider),
            abortSignal: new AbortController().signal,
            artifactStore: artifacts,
        },
    };
}

function projectInput(
    artifacts: InMemoryArtifactStore,
    overrides: {
        question?: InterviewQuestion;
        cluster?: QuestionCluster;
        clusterQuestions?: InterviewQuestion[];
    } = {},
): AnalyzeAnswerInput {
    const selectedQuestion = overrides.question ?? projectQuestion;
    const selectedCluster = overrides.cluster ?? cluster;
    const clusterQuestions =
        overrides.clusterQuestions ??
        (selectedCluster.id === cluster.id ? [projectQuestion, followUpQuestion] : [selectedQuestion]);
    const interview: StructuredInterview = {
        transcript: { source: "", turns: [] },
        questions: clusterQuestions,
        clusters: [selectedCluster],
        nonQuestionTurnIds: [],
    };
    const structuredInterviewArtifactId = artifacts.put("structured_interview", interview, { producer: "test" });
    return {
        structuredInterviewArtifactId,
        questionId: selectedQuestion.id,
    };
}

function storedAnalysis(artifacts: InMemoryArtifactStore, artifactId: string | undefined): QuestionAnalysis {
    assert.ok(artifactId);
    return artifacts.get<QuestionAnalysisArtifact>(artifactId, "question_analysis", "test").analysis;
}

test("题型 Rubric 只声明各题型适用的语义维度", () => {
    assert.deepEqual(QUESTION_RUBRICS, {
        project: {
            prompt: "评价项目背景、本人职责、决策依据、实施细节、结果证据和追问一致性，不与标准答案比较。",
            applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
        },
        knowledge: {
            prompt: "只基于当前问题和原回答，评价技术事实、关键知识点和原理深度；没有外部资料时不得假装完成资料核验。",
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

test("一次模型请求同时使用表达统计并返回表达质量分", async () => {
    const { provider, context, artifacts } = toolContext(validProjectResponse);
    const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

    assert.equal(result.success, true);
    const output = result.data as { artifactId?: string; status?: string; score?: number };
    assert.equal(output.status, "completed");
    assert.equal("originalAnswer" in output, false);
    assert.equal("strengths" in output, false);
    assert.equal("issues" in output, false);
    assert.equal("improvements" in output, false);
    const stored = storedAnalysis(artifacts, output.artifactId);
    assert.equal(stored.status, "completed");
    if (stored.status !== "completed") return;
    assert.equal(stored.dimensionScores.expressionQuality, 72);
    assert.equal(stored.dimensionScores.followUpHandling, null);
    assert.equal(output.score, 70);
    assert.equal(provider.requests.length, 1);
    const requestContent = provider.request?.messages[0];
    assert.equal(requestContent?.role, "user");
    if (requestContent?.role === "user") {
        const input = JSON.parse(requestContent.content);
        assert.deepEqual(input.expressionStats, expressionStats);
        assert.equal("references" in input, false);
    }
    assert.match(provider.request?.systemPrompt ?? "", /不与标准答案比较/);
    assert.match(provider.request?.systemPrompt ?? "", /expressionQuality/);
    assert.match(provider.request?.systemPrompt ?? "", /合法 JSON 格式示例/);
    assert.match(provider.request?.systemPrompt ?? "", /"evidenceTurnIds"/);
    assert.match(provider.request?.systemPrompt ?? "", /"dimensions"/);
    assert.match(provider.request?.systemPrompt ?? "", /"confidenceReason"/);
});

test("逐题分析 Artifact 记录所属的结构化面试 Artifact", async () => {
    const { context, artifacts } = toolContext(validProjectResponse);
    const input = projectInput(artifacts);

    const result = await createAnalyzeAnswerTool("fake-model").execute(input, context);

    assert.equal(result.success, true);
    assert.ok(result.data?.artifactId);
    const stored = artifacts.get<{
        structuredInterviewArtifactId: string;
        analysis: QuestionAnalysis;
    }>(result.data!.artifactId, "question_analysis", "test");
    assert.equal(stored.structuredInterviewArtifactId, input.structuredInterviewArtifactId);
    assert.equal(stored.analysis.questionId, input.questionId);
    assert.equal("structuredInterviewArtifactId" in stored.analysis, false);
});

/* test("项目事实提取失败时置信度上限为 0.54", async () => {
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
            expressionQuality: 72,
        },
        confidence: 0.95,
    };
    const { context } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute({
        question: knowledgeQuestion,
        cluster: knowledgeCluster,
        clusterQuestions: [knowledgeQuestion],
        projectFacts: null,
        expressionStats,
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
            expressionQuality: 72,
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
            expressionStats,
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
            expressionQuality: 72,
        },
    };
    const { provider, context } = toolContext(response);
    await createAnalyzeAnswerTool("fake-model").execute({
        question: knowledgeQuestion,
        cluster: knowledgeCluster,
        clusterQuestions: [knowledgeQuestion],
        projectFacts: null,
        expressionStats,
        references: ["  事件循环先执行同步任务  "],
    }, context);

    const requestContent = provider.request?.messages[0];
    assert.equal(requestContent?.role, "user");
    if (requestContent?.role === "user") {
        assert.deepEqual(JSON.parse(requestContent.content).references, [
            "事件循环先执行同步任务",
        ]);
    }
}); */

test("知识题仍按题型限制不适用维度", async () => {
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
            expressionQuality: 72,
        },
    };
    const { provider, context, artifacts } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(artifacts, {
            question: knowledgeQuestion,
            cluster: knowledgeCluster,
            clusterQuestions: [knowledgeQuestion],
        }),
        context,
    );

    assert.match(provider.request?.systemPrompt ?? "", /"analysisAndTradeoffs": null/);
    assert.match(provider.request?.systemPrompt ?? "", /"followUpHandling": null/);
    assert.equal(result.data?.status, "completed");
    const analysis = storedAnalysis(artifacts, result.data?.artifactId);
    assert.equal(analysis.status, "completed");
    if (analysis.status === "completed") {
        assert.equal(analysis.dimensionScores.analysisAndTradeoffs, null);
    }
});

test("流程题不调用 LLM 并直接返回 not_scored", async () => {
    const proceduralQuestion = question({ id: "q-procedural", questionType: "procedural" });
    const proceduralCluster = { ...cluster, questionIds: [proceduralQuestion.id] };
    const { provider, context, artifacts } = toolContext("不应读取");
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(artifacts, {
            question: proceduralQuestion,
            cluster: proceduralCluster,
            clusterQuestions: [proceduralQuestion],
        }),
        context,
    );

    assert.equal(result.data?.status, "not_scored");
    const analysis = storedAnalysis(artifacts, result.data?.artifactId);
    assert.deepEqual(analysis, {
        status: "not_scored",
        questionId: proceduralQuestion.id,
        clusterId: proceduralQuestion.clusterId,
    });
    assert.equal(provider.request, undefined);
});

test("预中止的流程题返回 timeout，不调用模型也不创建分析 Artifact", async () => {
    const proceduralQuestion = question({ id: "q-procedural", questionType: "procedural" });
    const proceduralCluster = { ...cluster, questionIds: [proceduralQuestion.id] };
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    const provider = new FakeTextProvider("不应读取");
    const controller = new AbortController();
    const input = projectInput(artifacts, {
        question: proceduralQuestion,
        cluster: proceduralCluster,
        clusterQuestions: [proceduralQuestion],
    });
    const artifactCountBefore = traceStore.list().filter((event) => event.name === "artifact.created").length;
    controller.abort();

    const result = await createAnalyzeAnswerTool("fake-model").execute(input, {
        queryEngine: new QueryEngine(provider),
        abortSignal: controller.signal,
        artifactStore: artifacts,
        tracer,
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.data, undefined);
    assert.equal(provider.request, undefined);
    assert.equal(traceStore.list().filter((event) => event.name === "artifact.created").length, artifactCountBefore);
});

test("拒绝不存在的证据轮次", async () => {
    const response = {
        ...validProjectResponse,
        issues: [
            {
                ...validProjectResponse.issues[0],
                evidenceTurnIds: ["turn-unknown"],
            },
        ],
    };
    const { context, artifacts } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "failed");
    assert.equal(storedAnalysis(artifacts, result.data?.artifactId).status, "failed");
});

test("strength 和 issue 都必须至少引用一个当前问题轮次", async () => {
    const invalidResponses = [
        {
            ...validProjectResponse,
            strengths: [
                {
                    ...validProjectResponse.strengths[0],
                    evidenceTurnIds: [],
                },
            ],
        },
        {
            ...validProjectResponse,
            issues: [
                {
                    ...validProjectResponse.issues[0],
                    evidenceTurnIds: [],
                },
            ],
        },
    ];

    for (const response of invalidResponses) {
        const { context, artifacts } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

        assert.equal(result.success, true);
        assert.equal(result.data?.status, "failed");
    }
});

test("题型不适用的维度分使当前题保存为脱敏的 failed", async () => {
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
            expressionQuality: 72,
        },
    };
    const { context, artifacts } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(artifacts, {
            question: knowledgeQuestion,
            cluster: knowledgeCluster,
            clusterQuestions: [knowledgeQuestion],
        }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "failed");
    const analysis = storedAnalysis(artifacts, result.data?.artifactId);
    assert.equal(analysis.status, "failed");
    if (analysis.status === "failed") {
        assert.equal(analysis.error, "回答分析失败");
    }
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
    const { context, artifacts } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(artifacts, {
            question: followUpQuestion,
        }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    const analysis = storedAnalysis(artifacts, result.data?.artifactId);
    if (analysis.status === "completed") {
        assert.equal(analysis.dimensionScores.followUpHandling, 84);
    }
});

test("追问位置只由 cluster.questionIds 决定，不依赖 clusterQuestions 数组顺序", async () => {
    const { context, artifacts } = toolContext(validProjectResponse);
    const result = await createAnalyzeAnswerTool("fake-model").execute(
        projectInput(artifacts, {
            clusterQuestions: [followUpQuestion, projectQuestion],
        }),
        context,
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    const analysis = storedAnalysis(artifacts, result.data?.artifactId);
    if (analysis.status === "completed") {
        assert.equal(analysis.dimensionScores.followUpHandling, null);
    }
});

test("每个 issue 必须恰好对应一个 improvement", async () => {
    const responses = [
        { ...validProjectResponse, improvements: [] },
        {
            ...validProjectResponse,
            improvements: [validProjectResponse.improvements[0], validProjectResponse.improvements[0]],
        },
        {
            ...validProjectResponse,
            improvements: [{ issueId: "issue-unknown", text: "无对应问题" }],
        },
    ];

    for (const response of responses) {
        const { context, artifacts } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);
        assert.equal(result.success, true);
        assert.equal(result.data?.status, "failed");
    }
});

test("clarification 只能引用当前簇 questionId", async () => {
    const response = {
        ...validProjectResponse,
        clarificationCandidates: [
            {
                factKey: "cluster-project.metric",
                question: "指标口径是什么？",
                affectedQuestionIds: ["q-outside"],
                impact: "high",
            },
        ],
    };
    const { context, artifacts } = toolContext(response);
    const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

    assert.equal(result.success, true);
    assert.equal(result.data?.status, "failed");
});

test("模型 JSON 或 Schema 失败时保存 failed Artifact 并继续流程", async () => {
    for (const response of ["不是 JSON", {}]) {
        const { context, artifacts } = toolContext(response);
        const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

        assert.equal(result.success, true);
        assert.equal(result.data?.status, "failed");
        assert.equal(result.data?.score, undefined);
        const analysis = storedAnalysis(artifacts, result.data?.artifactId);
        assert.equal(analysis.status, "failed");
        if (analysis.status === "failed") assert.ok(analysis.error.length > 0);
    }
});

test("analyze_answer 将 Artifact 和 questionId 问题作为输入错误", async () => {
    const { context, artifacts } = toolContext(validProjectResponse);
    const tool = createAnalyzeAnswerTool("fake-model");

    const missingArtifact = await tool.execute(
        {
            structuredInterviewArtifactId: "missing",
            questionId: projectQuestion.id,
        },
        context,
    );
    assert.equal(missingArtifact.success, false);
    assert.equal(missingArtifact.error?.code, "input_error");

    const wrongKindId = artifacts.put("file_text", "文字稿", { producer: "test" });
    const wrongKind = await tool.execute(
        {
            structuredInterviewArtifactId: wrongKindId,
            questionId: projectQuestion.id,
        },
        context,
    );
    assert.equal(wrongKind.success, false);
    assert.equal(wrongKind.error?.code, "input_error");

    const input = projectInput(artifacts);
    const unknownQuestion = await tool.execute({ ...input, questionId: "q-unknown" }, context);
    assert.equal(unknownQuestion.success, false);
    assert.equal(unknownQuestion.error?.code, "input_error");
});

test("模型请求中止时返回 timeout 且不保存 failed Artifact", async () => {
    for (const abortError of [
        Object.assign(new Error("aborted"), { name: "AbortError" }),
        Object.assign(new Error("aborted"), { code: "ABORT_ERR" }),
    ]) {
        const { context, artifacts } = toolContext(validProjectResponse);
        context.queryEngine.query = async () => {
            throw abortError;
        };
        const result = await createAnalyzeAnswerTool("fake-model").execute(projectInput(artifacts), context);

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "timeout");
        assert.equal(result.data, undefined);
    }
});
