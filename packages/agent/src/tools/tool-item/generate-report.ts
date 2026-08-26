import { z } from "zod";
import type {
    ClarificationCandidate,
    CompletedQuestionAnalysis,
    InterviewMetadata,
    InterviewReport,
    // JobMatchAnalysis,
    // ProjectFactSet,
    QuestionAnalysis,
    ReportQuestionItem,
    ReportReferenceItem,
} from "../../interview/analysis-types.js";
import { queryModelJson } from "../../interview/model-json.js";
import type { QuestionAnalysisArtifact } from "../../interview/artifact-payloads.js";
import { scoreInterview } from "../../interview/scoring.js";
import type { InterviewQuestionType, StructuredInterview } from "../../interview/types.js";
import type { Tool, ToolResult } from "../types.js";

const referenceItemSchema = z
    .object({
        text: z.string().min(1),
        questionIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

const summarySchema = z
    .object({
        levelSummary: z.string().min(1),
        strengths: z.array(referenceItemSchema),
        coreIssues: z.array(referenceItemSchema),
        priorityImprovements: z.array(referenceItemSchema).max(3),
    })
    .strict();

const SUMMARY_JSON_EXAMPLE = JSON.stringify(
    {
        levelSummary: "基于逐题证据的整体水平判断",
        strengths: [
            {
                text: "跨题稳定出现的强项",
                questionIds: ["question-0001"],
            },
        ],
        coreIssues: [
            {
                text: "跨题或高影响的核心问题",
                questionIds: ["question-0002"],
            },
        ],
        priorityImprovements: [
            {
                text: "优先级最高的改进动作",
                questionIds: ["question-0002"],
            },
        ],
    },
    null,
    2,
);

/* const jobMatchItemSchema = z.object({
    text: z.string().min(1),
    jdEvidence: z.string().min(1),
    questionIds: z.array(z.string().min(1)).min(1),
}).strict();

const jobMatchSchema = z.object({
    summary: z.string().min(1),
    matches: z.array(jobMatchItemSchema),
    gaps: z.array(jobMatchItemSchema),
}).strict(); */

export interface GenerateReportInput {
    structuredInterviewArtifactId: string;
    analysisArtifactIds: string[];
    stage: "provisional" | "final";
    returnDirectly?: boolean;
    metadata?: Partial<InterviewMetadata>;
}

interface ResolvedGenerateReportInput {
    structuredInterview: StructuredInterview;
    analyses: QuestionAnalysis[];
    // projectFactSets: ProjectFactSet[];
    stage: "provisional" | "final";
    metadata?: Partial<InterviewMetadata>;
    // jdText?: string;
}

export interface GenerateReportOutput {
    report: InterviewReport;
    markdown: string;
}

const IMPACT_ORDER = { high: 2, medium: 1, low: 0 } as const;

function isAbortError(error: unknown): boolean {
    const value = error as { name?: unknown; code?: unknown } | null;
    return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

const DIMENSION_LABELS = {
    contentQuality: "内容质量",
    depthAndEvidence: "深度与证据",
    analysisAndTradeoffs: "分析与权衡",
    followUpHandling: "追问应对",
    expressionQuality: "表达质量",
} as const;

const QUESTION_TYPE_LABELS: Record<InterviewQuestionType, string> = {
    project: "项目题",
    knowledge: "知识题",
    open: "开放题",
    behavior: "行为题",
    coding: "手写题",
    procedural: "流程题",
};

export function confidenceLabel(value: number): "高" | "中" | "低" {
    if (value >= 0.8) return "高";
    if (value >= 0.55) return "中";
    return "低";
}

function inputError(message: string): ToolResult<GenerateReportOutput> {
    return { success: false, error: { code: "input_error", message } };
}

function validateInput(input: ResolvedGenerateReportInput): void {
    const questionIds = input.structuredInterview.questions.map((question) => question.id);
    const knownQuestionIds = new Set(questionIds);
    // const turnById = new Map(
    //     input.structuredInterview.transcript.turns.map((turn) => [turn.id, turn]),
    // );
    const knownTurnIds = new Set(input.structuredInterview.transcript.turns.map((turn) => turn.id));
    if (knownQuestionIds.size !== questionIds.length) {
        throw new Error("结构化面试包含重复问题 ID");
    }

    const analysisIds = input.analyses.map((analysis) => analysis.questionId);
    if (new Set(analysisIds).size !== analysisIds.length) {
        throw new Error("逐题分析包含重复问题 ID");
    }
    const unknownAnalysisId = analysisIds.find((id) => !knownQuestionIds.has(id));
    if (unknownAnalysisId) throw new Error(`逐题分析引用未知问题: ${unknownAnalysisId}`);
    const missingAnalysisId = questionIds.find((id) => !analysisIds.includes(id));
    if (missingAnalysisId) throw new Error(`缺少逐题分析: ${missingAnalysisId}`);

    const clusterById = new Map(input.structuredInterview.clusters.map((cluster) => [cluster.id, cluster]));
    for (const question of input.structuredInterview.questions) {
        const cluster = clusterById.get(question.clusterId);
        if (!cluster?.questionIds.includes(question.id)) {
            throw new Error(`问题与问题簇不一致: ${question.id}`);
        }
    }
    for (const analysis of input.analyses) {
        const question = input.structuredInterview.questions.find((item) => item.id === analysis.questionId);
        if (question?.clusterId !== analysis.clusterId) {
            throw new Error(`逐题分析的问题簇不一致: ${analysis.questionId}`);
        }
        if (analysis.status === "completed") {
            for (const [dimension, value] of Object.entries(analysis.dimensionScores)) {
                if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
                    throw new Error(`维度分数越界: ${analysis.questionId}.${dimension}`);
                }
            }
            if (
                analysis.score !== null &&
                (!Number.isFinite(analysis.score) || analysis.score < 0 || analysis.score > 100)
            ) {
                throw new Error(`单题分数越界: ${analysis.questionId}`);
            }
            if (!Number.isFinite(analysis.confidence) || analysis.confidence < 0 || analysis.confidence > 1) {
                throw new Error(`置信度越界: ${analysis.questionId}`);
            }
            const allowedTurnIds = new Set([...question.promptTurnIds, ...question.answerTurnIds]);
            const observations = [...analysis.strengths, ...analysis.issues];
            const emptyEvidenceObservation = observations.find(
                (observation) => observation.evidenceTurnIds.length === 0,
            );
            if (emptyEvidenceObservation) {
                throw new Error(`逐题分析证据不能为空: ${analysis.questionId}.${emptyEvidenceObservation.id}`);
            }
            const unknownEvidenceId = observations
                .flatMap((observation) => observation.evidenceTurnIds)
                .find((turnId) => !knownTurnIds.has(turnId) || !allowedTurnIds.has(turnId));
            if (unknownEvidenceId) {
                throw new Error(`逐题分析引用未知或越界原文轮次: ${unknownEvidenceId}`);
            }
        }
    }

    /* const seenFactKeys = new Set<string>();
    for (const factSet of input.projectFactSets) {
        const cluster = clusterById.get(factSet.clusterId);
        if (!cluster) {
            throw new Error(`项目事实引用未知问题簇: ${factSet.clusterId}`);
        }
        const factKeys = factSet.facts.map((fact) => fact.key);
        if (new Set(factKeys).size !== factKeys.length) {
            throw new Error(`项目事实键重复或冲突: ${factSet.clusterId}`);
        }
        const clusterQuestionIds = new Set(cluster.questionIds);
        const clusterAnswerTurnIds = new Set(
            input.structuredInterview.questions
                .filter((question) => question.clusterId === factSet.clusterId)
                .flatMap((question) => question.answerTurnIds),
        );
        for (const fact of factSet.facts) {
            const keyNamespace = `${factSet.clusterId}.`;
            if (
                !fact.key.startsWith(keyNamespace)
                || !fact.key.slice(keyNamespace.length).trim()
            ) {
                throw new Error(
                    `项目事实 key 必须使用问题簇命名空间 ${keyNamespace}: ${fact.key}`,
                );
            }
            if (seenFactKeys.has(fact.key)) {
                throw new Error(`项目事实键重复或冲突: ${fact.key}`);
            }
            seenFactKeys.add(fact.key);
            const unknownEvidenceId = fact.evidenceTurnIds.find(
                (turnId) => !knownTurnIds.has(turnId)
                    || turnById.get(turnId)?.speaker !== "candidate"
                    || !clusterAnswerTurnIds.has(turnId),
            );
            if (unknownEvidenceId) {
                throw new Error(`项目事实引用未知或越界候选人轮次: ${unknownEvidenceId}`);
            }
            const unknownQuestionId = fact.affectedQuestionIds.find(
                (id) => !knownQuestionIds.has(id) || !clusterQuestionIds.has(id),
            );
            if (unknownQuestionId) {
                throw new Error(`项目事实引用未知或越界问题: ${unknownQuestionId}`);
            }
            if (
                fact.status !== "unknown"
                && (
                    !fact.evidenceQuote?.trim()
                    || !fact.evidenceTurnIds.some((turnId) => (
                        turnById.get(turnId)?.content.includes(fact.evidenceQuote!)
                    ))
                )
            ) {
                throw new Error(`项目事实逐字证据无法回到候选人原文: ${fact.key}`);
            }
            if (fact.status === "unknown" && fact.evidenceQuote !== null) {
                throw new Error(`未知项目事实不得包含逐字证据: ${fact.key}`);
            }
            if (
                fact.status === "stated"
                && (
                    !fact.value?.trim()
                    || !fact.evidenceQuote?.includes(fact.value)
                )
            ) {
                throw new Error(`stated value 必须逐字来自 evidenceQuote: ${fact.key}`);
            }
        }
    } */

    const clarificationCandidates = [
        // ...input.projectFactSets.flatMap((set) => set.clarificationCandidates),
        ...input.analyses.flatMap((analysis) =>
            analysis.status === "completed" ? analysis.clarificationCandidates : [],
        ),
    ];
    for (const candidate of clarificationCandidates) {
        const unknownQuestionId = candidate.affectedQuestionIds.find((id) => !knownQuestionIds.has(id));
        if (unknownQuestionId) {
            throw new Error(`待确认项引用未知问题: ${unknownQuestionId}`);
        }
    }
}

function mergeClarifications(candidates: ClarificationCandidate[], questionOrder: string[]): ClarificationCandidate[] {
    const merged = new Map<string, ClarificationCandidate>();
    for (const candidate of candidates) {
        if (candidate.impact === "low") continue;
        const current = merged.get(candidate.factKey);
        if (!current) {
            merged.set(candidate.factKey, {
                ...candidate,
                affectedQuestionIds: [...new Set(candidate.affectedQuestionIds)],
            });
            continue;
        }
        const useIncoming = IMPACT_ORDER[candidate.impact] > IMPACT_ORDER[current.impact];
        merged.set(candidate.factKey, {
            factKey: candidate.factKey,
            question: useIncoming ? candidate.question : current.question,
            impact: useIncoming ? candidate.impact : current.impact,
            affectedQuestionIds: [...new Set([...current.affectedQuestionIds, ...candidate.affectedQuestionIds])],
        });
    }

    const questionIndex = new Map(questionOrder.map((id, index) => [id, index]));
    return [...merged.values()]
        .map((candidate) => ({
            ...candidate,
            affectedQuestionIds: [...candidate.affectedQuestionIds].sort(
                (left, right) => (questionIndex.get(left) ?? Infinity) - (questionIndex.get(right) ?? Infinity),
            ),
        }))
        .sort(
            (left, right) =>
                IMPACT_ORDER[right.impact] - IMPACT_ORDER[left.impact] ||
                right.affectedQuestionIds.length - left.affectedQuestionIds.length ||
                left.factKey.localeCompare(right.factKey),
        )
        .slice(0, 5);
}

function createQuestionItems(
    structuredInterview: StructuredInterview,
    analyses: QuestionAnalysis[],
): ReportQuestionItem[] {
    const analysisByQuestion = new Map(analyses.map((analysis) => [analysis.questionId, analysis]));
    const clusterById = new Map(structuredInterview.clusters.map((cluster) => [cluster.id, cluster]));

    return structuredInterview.questions.map((question) => {
        const analysis = analysisByQuestion.get(question.id)!;
        const base = {
            questionId: question.id,
            originalQuestion: question.originalQuestion,
            originalAnswer: question.originalAnswer,
            label: `${clusterById.get(question.clusterId)!.title} / ${QUESTION_TYPE_LABELS[question.questionType]}`,
        };
        if (analysis.status === "completed") {
            return {
                ...base,
                issues: analysis.issues.map((issue) => issue.text),
                improvements: analysis.improvements.map((item) => item.text),
                score: analysis.score,
                confidenceLabel: confidenceLabel(analysis.confidence),
                confidenceReason: analysis.confidenceReason,
                status: analysis.status,
            };
        }
        return {
            ...base,
            issues: analysis.status === "failed" ? [analysis.error] : [],
            improvements: [],
            score: null,
            confidenceLabel: null,
            confidenceReason: null,
            status: analysis.status,
        };
    });
}

function validateSummaryEvidence(items: ReportReferenceItem[], knownQuestionIds: Set<string>): void {
    for (const item of items) {
        const unknownQuestionId = item.questionIds.find((id) => !knownQuestionIds.has(id));
        if (unknownQuestionId) throw new Error(`总结引用未知问题: ${unknownQuestionId}`);
    }
}

function renderReferences(title: string, items: ReportReferenceItem[]): string[] {
    if (!items.length) return [`### ${title}`, "", "- 无"];
    return [`### ${title}`, "", ...items.map((item) => `- ${item.text}（${item.questionIds.join("、")}）`)];
}

function renderQuestion(question: ReportQuestionItem, index: number): string[] {
    const lines = [
        `### Q${index + 1}`,
        "",
        `原问题：${question.originalQuestion}`,
        "",
        `原回答：${question.originalAnswer}`,
        "",
        `标签：${question.label}`,
        "",
        `问题：${question.issues.length ? question.issues.join("；") : "无明显问题"}`,
        "",
        `改进方向：${question.improvements.length ? question.improvements.join("；") : "无"}`,
        "",
    ];
    if (question.status === "not_scored") return [...lines, "分数：不参与评分"];
    if (question.status === "failed") return [...lines, "分数：分析失败"];
    lines.push(`分数：${question.score === null ? "不可评价" : `${question.score}/100`}`);
    lines.push("");
    lines.push(`置信度：${question.confidenceLabel}（${question.confidenceReason ?? "无说明"}）`);
    return lines;
}

/* function renderJobMatch(report: InterviewReport): string[] {
    if (report.jobMatchStatus === "not_provided") return [];
    if (report.jobMatchStatus === "failed" || !report.jobMatch) {
        return ["## 岗位匹配", "", "岗位匹配：不可评价", ""];
    }
    const renderItems = (title: string, items: JobMatchAnalysis["matches"]) => [
        `### ${title}`,
        "",
        ...(items.length ? items.map((item) => (
            `- ${item.text}；JD 证据：${item.jdEvidence}（${item.questionIds.join("、")}）`
        )) : ["- 无"]),
    ];
    return [
        "## 岗位匹配", "", report.jobMatch.summary, "",
        ...renderItems("匹配项", report.jobMatch.matches), "",
        ...renderItems("差距项", report.jobMatch.gaps), "",
    ];
} */

export function renderInterviewReport(report: InterviewReport): string {
    const dimensionLines = Object.entries(DIMENSION_LABELS).map(([key, label]) => {
        const value = report.score.dimensions[key as keyof typeof report.score.dimensions];
        return `- ${label}：${value === null ? "不可评价" : `${value}/100`}`;
    });
    const pendingLines = report.pendingClarifications.length
        ? report.pendingClarifications.map(
              (item) => `- [${item.impact}] ${item.question}（${item.affectedQuestionIds.join("、")}）`,
          )
        : ["- 无"];
    const levelSummary =
        report.summaryStatus === "completed" ? report.levelSummary : "汇总失败；分数和逐题分析仍可使用。";

    return [
        "# 面试分析报告",
        "",
        `公司：${report.metadata.company ?? "未提供"}`,
        "",
        `岗位：${report.metadata.position ?? "未提供"}`,
        "",
        `日期：${report.metadata.date ?? "未提供"}`,
        "",
        `轮次：${report.metadata.round ?? "未提供"}`,
        "",
        `报告状态：${report.stage === "provisional" ? "暂定" : "最终"}`,
        ...(report.notice ? ["", report.notice] : []),
        "",
        `总分：${report.score.totalScore === null ? "不可评价" : `${report.score.totalScore}/100`}`,
        "",
        `已分析：${report.score.coverage.analyzed}/${report.score.coverage.expected}`,
        "",
        `水平说明：${levelSummary}`,
        "",
        "### 五维分数",
        "",
        ...dimensionLines,
        "",
        ...renderReferences("核心强项", report.strengths),
        "",
        ...renderReferences("核心问题", report.coreIssues),
        "",
        ...renderReferences("优先改进", report.priorityImprovements),
        "",
        "### 待确认项",
        "",
        ...pendingLines,
        "",
        // ...renderJobMatch(report),
        "## 具体问题列表",
        "",
        ...report.questions.flatMap((question, index) => [...renderQuestion(question, index), ""]),
    ]
        .join("\n")
        .trimEnd();
}

export function createGenerateReportTool(model: string): Tool<GenerateReportInput, GenerateReportOutput> {
    return {
        name: "generate_report",
        description: "生成可追溯的面试分析结构化报告和确定性 Markdown。",
        parameters: {
            type: "object",
            properties: {
                structuredInterviewArtifactId: {
                    type: "string",
                    description: "structure_interview 返回的 structured_interview Artifact ID",
                },
                analysisArtifactIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "analyze_answer 返回的全部 question_analysis Artifact ID",
                },
                // projectFactSets: { type: "array", description: "项目事实集合" },
                stage: { type: "string", enum: ["provisional", "final"] },
                returnDirectly: {
                    type: "boolean",
                    description: "true 直接返回报告；false 供后续 write_file 保存",
                },
                metadata: { type: "object", description: "面试元数据" },
                // jdText: { type: "string", description: "可选岗位描述原文" },
            },
            required: ["structuredInterviewArtifactId", "analysisArtifactIds", "stage"],
            additionalProperties: false,
        },
        getFinalOutput(input, result) {
            if (input.returnDirectly === false) return undefined;
            if (!result.success || !result.data?.markdown.trim()) return undefined;
            return result.data.markdown;
        },
        async execute(input, ctx) {
            if (input.returnDirectly !== undefined && typeof input.returnDirectly !== "boolean") {
                return inputError("returnDirectly 必须是布尔值");
            }
            if (!ctx.artifactStore) {
                return inputError("ArtifactStore 未初始化");
            }
            if (!input.structuredInterviewArtifactId?.trim()) {
                return inputError("structuredInterviewArtifactId 必填");
            }
            if (!Array.isArray(input.analysisArtifactIds) || input.analysisArtifactIds.some((id) => !id?.trim())) {
                return inputError("analysisArtifactIds 必须是 Artifact ID 数组");
            }
            if (new Set(input.analysisArtifactIds).size !== input.analysisArtifactIds.length) {
                return inputError("analysisArtifactIds 不得重复");
            }

            let resolvedInput: ResolvedGenerateReportInput;
            try {
                const structuredInterview = ctx.artifactStore.get<StructuredInterview>(
                    input.structuredInterviewArtifactId,
                    "structured_interview",
                    "generate_report",
                );
                const analysisArtifacts = input.analysisArtifactIds.map((artifactId) =>
                    ctx.artifactStore!.get<QuestionAnalysisArtifact>(
                        artifactId,
                        "question_analysis",
                        "generate_report",
                    ),
                );
                if (
                    analysisArtifacts.some(
                        (artifact) => artifact.structuredInterviewArtifactId !== input.structuredInterviewArtifactId,
                    )
                ) {
                    throw new Error("逐题分析 Artifact 来自其他结构化面试");
                }
                resolvedInput = {
                    structuredInterview,
                    analyses: analysisArtifacts.map((artifact) => artifact.analysis),
                    stage: input.stage,
                    ...(input.metadata ? { metadata: input.metadata } : {}),
                };
            } catch (error) {
                return inputError(error instanceof Error ? error.message : "报告 Artifact 读取失败");
            }

            try {
                validateInput(resolvedInput);
            } catch (error) {
                return inputError(error instanceof Error ? error.message : "报告输入无效");
            }

            if (ctx.abortSignal.aborted) {
                return {
                    success: false,
                    error: { code: "timeout", message: "操作已中止" },
                };
            }

            const scoredQuestionIds = new Set(
                resolvedInput.structuredInterview.questions
                    .filter((question) => question.scored)
                    .map((question) => question.id),
            );
            const completedScoredAnalyses = resolvedInput.analyses.filter(
                (analysis): analysis is CompletedQuestionAnalysis =>
                    analysis.status === "completed" && scoredQuestionIds.has(analysis.questionId),
            );
            let score: InterviewReport["score"];
            if (!completedScoredAnalyses.length) {
                score = {
                    totalScore: null,
                    dimensions: {
                        contentQuality: null,
                        depthAndEvidence: null,
                        analysisAndTradeoffs: null,
                        followUpHandling: null,
                        expressionQuality: null,
                    },
                    clusterScores: [],
                    coverage: {
                        analyzed: completedScoredAnalyses.length,
                        expected: scoredQuestionIds.size,
                    },
                };
            } else {
                try {
                    score = scoreInterview({
                        questions: resolvedInput.structuredInterview.questions,
                        clusters: resolvedInput.structuredInterview.clusters,
                        analyses: resolvedInput.analyses,
                    });
                } catch (error) {
                    return inputError(error instanceof Error ? error.message : "无法计算面试分数");
                }
            }

            const pendingClarifications = mergeClarifications(
                [
                    // ...input.projectFactSets.flatMap((set) => set.clarificationCandidates),
                    ...resolvedInput.analyses.flatMap((analysis) =>
                        analysis.status === "completed" ? analysis.clarificationCandidates : [],
                    ),
                ],
                resolvedInput.structuredInterview.questions.map((question) => question.id),
            );
            if (resolvedInput.stage === "final" && pendingClarifications.some((item) => item.impact === "high")) {
                return inputError("仍有高影响待确认项，不能生成最终报告");
            }

            const questions = createQuestionItems(resolvedInput.structuredInterview, resolvedInput.analyses);
            let summaryStatus: InterviewReport["summaryStatus"] = score.totalScore === null ? "completed" : "failed";
            let levelSummary = score.totalScore === null ? "无可评分数据，无法生成整体水平判断。" : "";
            let strengths: ReportReferenceItem[] = [];
            let coreIssues: ReportReferenceItem[] = [];
            let priorityImprovements: ReportReferenceItem[] = [];
            if (score.totalScore !== null) {
                try {
                    const summary = await queryModelJson({
                        queryEngine: ctx.queryEngine,
                        model,
                        abortSignal: ctx.abortSignal,
                        tracer: ctx.tracer,
                        traceOperation: "generate_report_summary",
                        schema: summarySchema,
                        systemPrompt: [
                            "基于给定的确定性分数和逐题分析生成报告第一层总结，严格输出 JSON。",
                            "每条强项、核心问题和优先改进都必须引用输入中存在的 questionId。",
                            "不得改写原问题和原回答，不得引入输入之外的事实。",
                            "priorityImprovements 最多返回 3 条。",
                            "JSON 根对象只能包含 levelSummary、strengths、coreIssues、priorityImprovements。",
                            "strengths、coreIssues 和 priorityImprovements 每项只能包含 text、questionIds。",
                            "合法 JSON 格式示例：",
                            SUMMARY_JSON_EXAMPLE,
                            "只返回一个 JSON 对象；不得使用 Markdown 代码块，不得附加解释文字。",
                        ].join("\n"),
                        userContent: JSON.stringify({ score, questions }),
                    });
                    const knownQuestionIds = new Set(
                        resolvedInput.structuredInterview.questions.map((question) => question.id),
                    );
                    validateSummaryEvidence(
                        [...summary.strengths, ...summary.coreIssues, ...summary.priorityImprovements],
                        knownQuestionIds,
                    );
                    summaryStatus = "completed";
                    levelSummary = summary.levelSummary;
                    strengths = summary.strengths;
                    coreIssues = summary.coreIssues;
                    priorityImprovements = summary.priorityImprovements;
                } catch (error) {
                    if (isAbortError(error) || ctx.abortSignal.aborted) {
                        return {
                            success: false,
                            error: { code: "timeout", message: "操作已中止" },
                        };
                    }
                    // 汇总是可降级步骤；确定性分数和逐题分析保持可用。
                }
            }

            /* const knownQuestionIds = new Set(
                input.structuredInterview.questions.map((question) => question.id),
            );
            let jobMatchStatus: InterviewReport["jobMatchStatus"] = input.jdText?.trim()
                ? "failed"
                : "not_provided";
            let jobMatch: JobMatchAnalysis | null = null;
            if (input.jdText?.trim()) {
                try {
                    const generated = await queryModelJson({
                        queryEngine: ctx.queryEngine,
                        model,
                        abortSignal: ctx.abortSignal,
                        tracer: ctx.tracer,
                        traceOperation: "evaluate_job_match",
                        schema: jobMatchSchema,
                        systemPrompt: [
                            "比较岗位描述与面试证据，严格输出 JSON。",
                            "每项必须逐字引用 JD 片段，并引用输入中存在的 questionId。",
                            "岗位匹配不产生分数，也不得修改面试分数。",
                        ].join("\n"),
                        userContent: JSON.stringify({
                            jdText: input.jdText,
                            questions,
                        }),
                    });
                    for (const item of [...generated.matches, ...generated.gaps]) {
                        if (!input.jdText.includes(item.jdEvidence)) {
                            throw new Error("岗位匹配证据无法回到 JD 原文");
                        }
                        const unknownId = item.questionIds.find((id) => !knownQuestionIds.has(id));
                        if (unknownId) throw new Error(`岗位匹配引用未知问题: ${unknownId}`);
                    }
                    jobMatchStatus = "completed";
                    jobMatch = generated;
                } catch {
                    // JD 匹配独立降级，不影响面试评分和总结。
                }
            } */

            // const jobMatchStatus: InterviewReport["jobMatchStatus"] = "not_provided";
            // const jobMatch = null;

            const report: InterviewReport = {
                stage: resolvedInput.stage,
                notice:
                    score.totalScore === null
                        ? "无可评分数据：所有计分题均分析失败，或本次面试仅包含不计分题；总分不可评价。"
                        : resolvedInput.stage === "provisional"
                          ? "当前为暂定总分，补充待确认事实后可能调整。"
                          : null,
                metadata: {
                    company: resolvedInput.metadata?.company?.trim() || null,
                    position: resolvedInput.metadata?.position?.trim() || null,
                    date: resolvedInput.metadata?.date?.trim() || null,
                    round: resolvedInput.metadata?.round?.trim() || null,
                },
                score,
                summaryStatus,
                levelSummary,
                strengths,
                coreIssues,
                priorityImprovements,
                // jobMatchStatus,
                // jobMatch,
                pendingClarifications,
                questions,
            };
            return {
                success: true,
                data: { report, markdown: renderInterviewReport(report) },
            };
        },
    };
}
