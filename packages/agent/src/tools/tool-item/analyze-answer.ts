import { z } from "zod";
import type {
    AnalysisObservation,
    ClarificationCandidate,
    CompletedQuestionAnalysis,
    DimensionScores,
    NotScoredQuestionAnalysis,
    ProjectFactSet,
    ExpressionAnalysis,
} from "../../interview/analysis-types.js";
import { queryModelJson } from "../../interview/model-json.js";
import { QUESTION_RUBRICS } from "../../interview/rubrics.js";
import { calculateQuestionScore } from "../../interview/scoring.js";
import type {
    InterviewQuestion,
    QuestionCluster,
} from "../../interview/types.js";
import type { Tool } from "../types.js";

const observationSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    impact: z.string().min(1),
    evidenceTurnIds: z.array(z.string().min(1)),
}).strict();

const clarificationSchema = z.object({
    factKey: z.string().min(1),
    question: z.string().min(1),
    affectedQuestionIds: z.array(z.string().min(1)),
    impact: z.enum(["high", "medium", "low"]),
}).strict();

const responseSchema = z.object({
    strengths: z.array(observationSchema).max(2),
    issues: z.array(observationSchema).max(3),
    improvements: z.array(z.object({
        issueId: z.string().min(1),
        text: z.string().min(1),
    }).strict()),
    dimensions: z.object({
        contentQuality: z.number().min(0).max(100).nullable(),
        depthAndEvidence: z.number().min(0).max(100).nullable(),
        analysisAndTradeoffs: z.number().min(0).max(100).nullable(),
        followUpHandling: z.number().min(0).max(100).nullable(),
    }).strict(),
    confidence: z.number().min(0).max(1),
    confidenceReason: z.string().min(1),
    clarificationCandidates: z.array(clarificationSchema),
}).strict();

export interface AnalyzeAnswerInput {
    question: InterviewQuestion;
    cluster: QuestionCluster;
    clusterQuestions: InterviewQuestion[];
    projectFacts?: ProjectFactSet | null;
    expression: ExpressionAnalysis;
    references?: string[];
}

type AnalyzeAnswerOutput = CompletedQuestionAnalysis | NotScoredQuestionAnalysis;
type SemanticDimension = Exclude<keyof DimensionScores, "expressionQuality">;

const SEMANTIC_DIMENSIONS: SemanticDimension[] = [
    "contentQuality",
    "depthAndEvidence",
    "analysisAndTradeoffs",
    "followUpHandling",
];

function sameMembers(left: string[], right: string[]): boolean {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length
        && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateInput(input: AnalyzeAnswerInput): number {
    if (input.question.clusterId !== input.cluster.id) {
        throw new Error("当前问题不属于输入问题簇");
    }
    const questionIndex = input.cluster.questionIds.indexOf(input.question.id);
    if (questionIndex < 0) {
        throw new Error("当前问题不在问题簇 questionIds 中");
    }
    const clusterQuestionIds = input.clusterQuestions.map((question) => question.id);
    if (
        !sameMembers(clusterQuestionIds, input.cluster.questionIds)
        || input.clusterQuestions.some((question) => question.clusterId !== input.cluster.id)
    ) {
        throw new Error("问题簇与 clusterQuestions 不一致");
    }
    if (input.expression.questionId !== input.question.id) {
        throw new Error("表达分析与当前问题不一致");
    }
    if (input.projectFacts && input.projectFacts.clusterId !== input.cluster.id) {
        throw new Error("项目事实与当前问题簇不一致");
    }
    return questionIndex;
}

function validateEvidence(
    observations: AnalysisObservation[],
    allowedTurnIds: Set<string>,
): void {
    for (const observation of observations) {
        if (observation.evidenceTurnIds.some((turnId) => !allowedTurnIds.has(turnId))) {
            throw new Error(`分析证据不属于当前问题: ${observation.id}`);
        }
    }
}

function validateImprovements(input: {
    issues: AnalysisObservation[];
    improvements: Array<{ issueId: string; text: string }>;
}): void {
    const issueIds = input.issues.map((issue) => issue.id);
    if (new Set(issueIds).size !== issueIds.length) {
        throw new Error("issue id 必须唯一");
    }
    const counts = new Map<string, number>();
    for (const improvement of input.improvements) {
        if (!issueIds.includes(improvement.issueId)) {
            throw new Error(`改进项引用了不存在的 issue: ${improvement.issueId}`);
        }
        counts.set(improvement.issueId, (counts.get(improvement.issueId) ?? 0) + 1);
    }
    if (issueIds.some((issueId) => counts.get(issueId) !== 1)) {
        throw new Error("每个 issue 必须恰好对应一个 improvement");
    }
}

function validateDimensions(
    dimensions: Record<SemanticDimension, number | null>,
    applicableDimensions: Set<SemanticDimension>,
): void {
    for (const dimension of SEMANTIC_DIMENSIONS) {
        if (!applicableDimensions.has(dimension) && dimensions[dimension] !== null) {
            throw new Error(`题型不适用维度必须为 null: ${dimension}`);
        }
    }
}

function validateClarifications(
    candidates: ClarificationCandidate[],
    clusterQuestionIds: Set<string>,
): void {
    for (const candidate of candidates) {
        if (candidate.affectedQuestionIds.some((id) => !clusterQuestionIds.has(id))) {
            throw new Error(`澄清项引用了当前问题簇外的问题: ${candidate.factKey}`);
        }
    }
}

export function createAnalyzeAnswerTool(
    model: string,
): Tool<AnalyzeAnswerInput, AnalyzeAnswerOutput> {
    return {
        name: "analyze_answer",
        description: "按问题题型、证据边界和适用维度分析单个面试回答。",
        parameters: {
            type: "object",
            properties: {
                question: { type: "object", description: "当前面试问题" },
                cluster: { type: "object", description: "当前问题簇" },
                clusterQuestions: { type: "array", description: "当前问题簇的全部问题" },
                projectFacts: { type: ["object", "null"], description: "可选的项目事实提取结果" },
                expression: { type: "object", description: "当前回答的表达分析" },
                references: { type: "array", description: "可选参考资料文本" },
            },
            required: ["question", "cluster", "clusterQuestions", "expression"],
            additionalProperties: false,
        },
        async execute(input, ctx) {
            if (input.question.questionType === "procedural") {
                return {
                    success: true,
                    data: {
                        status: "not_scored",
                        questionId: input.question.id,
                        clusterId: input.question.clusterId,
                    },
                };
            }

            try {
                const questionIndex = validateInput(input);
                const rubric = QUESTION_RUBRICS[input.question.questionType];
                const applicableDimensions = new Set<SemanticDimension>(
                    rubric.applicableDimensions,
                );
                if (questionIndex > 0) applicableDimensions.add("followUpHandling");

                const references = input.question.questionType === "knowledge"
                    ? (input.references ?? [])
                        .map((reference) => reference.trim())
                        .filter((reference) => reference.length > 0)
                    : [];
                const response = await queryModelJson({
                    queryEngine: ctx.queryEngine,
                    model,
                    abortSignal: ctx.abortSignal,
                    schema: responseSchema,
                    systemPrompt: [
                        "只基于输入分析当前面试回答，严格输出 JSON。",
                        rubric.prompt,
                        `允许评分的语义维度: ${[...applicableDimensions].join(", ")}。`,
                        "不适用的语义维度必须返回 null。不得返回表达质量分或总分。",
                        "strength 和 issue 只能引用当前问题给出的 promptTurnIds 或 answerTurnIds。",
                        "每个 issue 必须恰好有一个 improvement，且 improvement.issueId 必须引用该 issue。",
                        "clarificationCandidates 只能引用当前问题簇的 questionId。",
                    ].join("\n"),
                    userContent: JSON.stringify({
                        question: input.question,
                        cluster: input.cluster,
                        clusterQuestions: input.clusterQuestions,
                        projectFacts: input.question.questionType === "project"
                            ? input.projectFacts ?? null
                            : undefined,
                        references: references.length ? references : undefined,
                    }),
                });

                const allowedTurnIds = new Set([
                    ...input.question.promptTurnIds,
                    ...input.question.answerTurnIds,
                ]);
                validateEvidence([...response.strengths, ...response.issues], allowedTurnIds);
                validateImprovements(response);
                validateDimensions(response.dimensions, applicableDimensions);
                validateClarifications(
                    response.clarificationCandidates,
                    new Set(input.cluster.questionIds),
                );

                const dimensionScores: DimensionScores = {
                    ...response.dimensions,
                    expressionQuality: input.expression.score,
                };
                let confidence = response.confidence;
                if (input.question.questionType === "project" && !input.projectFacts) {
                    confidence = Math.min(confidence, 0.54);
                }
                if (input.question.questionType === "knowledge" && references.length === 0) {
                    confidence = Math.min(confidence, 0.79);
                }

                return {
                    success: true,
                    data: {
                        status: "completed",
                        questionId: input.question.id,
                        clusterId: input.question.clusterId,
                        questionType: input.question.questionType,
                        strengths: response.strengths,
                        issues: response.issues,
                        improvements: response.improvements,
                        dimensionScores,
                        score: calculateQuestionScore(dimensionScores),
                        confidence,
                        confidenceReason: response.confidenceReason,
                        clarificationCandidates: response.clarificationCandidates,
                    },
                };
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: error instanceof Error ? error.message : "逐题分析失败",
                    },
                };
            }
        },
    };
}
