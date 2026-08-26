import { z } from "zod";
import type {
    AnalysisObservation,
    ClarificationCandidate,
    CompletedQuestionAnalysis,
    DimensionScores,
    FailedQuestionAnalysis,
    NotScoredQuestionAnalysis,
    QuestionAnalysis,
} from "../../interview/analysis-types.js";
import { collectExpressionStats } from "../../interview/expression-statistics.js";
import type { QuestionAnalysisArtifact } from "../../interview/artifact-payloads.js";
import { queryModelJson } from "../../interview/model-json.js";
import { QUESTION_RUBRICS } from "../../interview/rubrics.js";
import { calculateQuestionScore } from "../../interview/scoring.js";
import type { InterviewQuestion, QuestionCluster, StructuredInterview } from "../../interview/types.js";
import type { Tool } from "../types.js";

const observationSchema = z
    .object({
        id: z.string().min(1),
        text: z.string().min(1),
        impact: z.string().min(1),
        evidenceTurnIds: z.array(z.string().min(1)).min(1),
    })
    .strict();

const clarificationSchema = z
    .object({
        factKey: z.string().min(1),
        question: z.string().min(1),
        affectedQuestionIds: z.array(z.string().min(1)),
        impact: z.enum(["high", "medium", "low"]),
    })
    .strict();

const responseSchema = z
    .object({
        strengths: z.array(observationSchema).max(2),
        issues: z.array(observationSchema).max(3),
        improvements: z.array(
            z
                .object({
                    issueId: z.string().min(1),
                    text: z.string().min(1),
                })
                .strict(),
        ),
        dimensions: z
            .object({
                contentQuality: z.number().min(0).max(100).nullable().describe("内容质量分；0-100，不适用时为 null"),
                depthAndEvidence: z
                    .number()
                    .min(0)
                    .max(100)
                    .nullable()
                    .describe("深度与证据分；0-100，不适用时为 null"),
                analysisAndTradeoffs: z
                    .number()
                    .min(0)
                    .max(100)
                    .nullable()
                    .describe("分析与权衡分；0-100，不适用时为 null"),
                followUpHandling: z.number().min(0).max(100).nullable().describe("追问处理分；0-100，非追问时为 null"),
                expressionQuality: z.number().min(0).max(100).describe("表达质量分；0-100，结合原回答和程序统计判断"),
            })
            .strict(),
        confidence: z.number().min(0).max(1),
        confidenceReason: z.string().min(1),
        clarificationCandidates: z.array(clarificationSchema),
    })
    .strict();

export interface AnalyzeAnswerInput {
    structuredInterviewArtifactId: string;
    questionId: string;
}

export interface AnalyzeAnswerOutput {
    artifactId: string;
    questionId: string;
    clusterId: string;
    status: QuestionAnalysis["status"];
    score?: number;
}
type SemanticDimension = Exclude<keyof DimensionScores, "expressionQuality">;

const SEMANTIC_DIMENSIONS: SemanticDimension[] = [
    "contentQuality",
    "depthAndEvidence",
    "analysisAndTradeoffs",
    "followUpHandling",
];

function jsonOutputExample(applicableDimensions: Set<SemanticDimension>): string {
    const dimensionScore = (dimension: SemanticDimension): number | null =>
        applicableDimensions.has(dimension) ? 65 : null;
    return JSON.stringify(
        {
            strengths: [
                {
                    id: "strength-1",
                    text: "回答中的具体优点",
                    impact: "该优点对回答质量的影响",
                    evidenceTurnIds: ["turn-0002"],
                },
            ],
            issues: [
                {
                    id: "issue-1",
                    text: "回答中的具体问题",
                    impact: "该问题对回答质量的影响",
                    evidenceTurnIds: ["turn-0002"],
                },
            ],
            improvements: [
                {
                    issueId: "issue-1",
                    text: "针对该问题的改进方法",
                },
            ],
            dimensions: {
                contentQuality: dimensionScore("contentQuality"),
                depthAndEvidence: dimensionScore("depthAndEvidence"),
                analysisAndTradeoffs: dimensionScore("analysisAndTradeoffs"),
                followUpHandling: dimensionScore("followUpHandling"),
                expressionQuality: 70,
            },
            confidence: 0.8,
            confidenceReason: "置信度理由",
            clarificationCandidates: [],
        },
        null,
        2,
    );
}

// // 未经用户确认的推断事实最多支持“中”置信度。
// export const INFERRED_PROJECT_FACT_CONFIDENCE_CAP = 0.79;

function sameMembers(left: string[], right: string[]): boolean {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validateInput(input: {
    question: InterviewQuestion;
    cluster: QuestionCluster;
    clusterQuestions: InterviewQuestion[];
}): number {
    if (input.question.clusterId !== input.cluster.id) {
        throw new Error("当前问题不属于输入问题簇");
    }
    const questionIndex = input.cluster.questionIds.indexOf(input.question.id);
    if (questionIndex < 0) {
        throw new Error("当前问题不在问题簇 questionIds 中");
    }
    const clusterQuestionIds = input.clusterQuestions.map((question) => question.id);
    if (
        !sameMembers(clusterQuestionIds, input.cluster.questionIds) ||
        input.clusterQuestions.some((question) => question.clusterId !== input.cluster.id)
    ) {
        throw new Error("问题簇与 clusterQuestions 不一致");
    }
    // if (input.projectFacts && input.projectFacts.clusterId !== input.cluster.id) {
    //     throw new Error("项目事实与当前问题簇不一致");
    // }
    return questionIndex;
}

function validateEvidence(observations: AnalysisObservation[], allowedTurnIds: Set<string>): void {
    for (const observation of observations) {
        if (!observation.evidenceTurnIds.length) {
            throw new Error(`分析证据不能为空: ${observation.id}`);
        }
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

function isAbortError(error: unknown): boolean {
    const value = error as { name?: unknown; code?: unknown } | null;
    return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

const SAFE_ANALYSIS_FAILURE_MESSAGES = new Set([
    "结构化模型请求失败",
    "结构化模型输出无效",
    "结构化模型输出达到 Token 上限，JSON 可能被截断",
    "结构化任务未返回文本",
]);

function safeAnalysisFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return SAFE_ANALYSIS_FAILURE_MESSAGES.has(message) ? message : "回答分析失败";
}

function validateClarifications(candidates: ClarificationCandidate[], clusterQuestionIds: Set<string>): void {
    for (const candidate of candidates) {
        if (candidate.affectedQuestionIds.some((id) => !clusterQuestionIds.has(id))) {
            throw new Error(`澄清项引用了当前问题簇外的问题: ${candidate.factKey}`);
        }
    }
}

export function createAnalyzeAnswerTool(model: string): Tool<AnalyzeAnswerInput, AnalyzeAnswerOutput> {
    return {
        name: "analyze_answer",
        description: "按问题题型、证据边界和适用维度分析单个面试回答。",
        parameters: {
            type: "object",
            properties: {
                structuredInterviewArtifactId: {
                    type: "string",
                    description: "structure_interview 返回的 structured_interview Artifact ID",
                },
                questionId: { type: "string", description: "待分析的问题 ID" },
            },
            required: ["structuredInterviewArtifactId", "questionId"],
            additionalProperties: false,
        },
        async execute(input, ctx) {
            if (!input.structuredInterviewArtifactId?.trim() || !input.questionId?.trim()) {
                return {
                    success: false,
                    error: {
                        code: "input_error",
                        message: "structuredInterviewArtifactId 和 questionId 必填",
                    },
                };
            }
            if (!ctx.artifactStore) {
                return {
                    success: false,
                    error: { code: "input_error", message: "ArtifactStore 未初始化" },
                };
            }

            let question: InterviewQuestion;
            let cluster: QuestionCluster;
            let clusterQuestions: InterviewQuestion[];
            try {
                const interview = ctx.artifactStore.get<StructuredInterview>(
                    input.structuredInterviewArtifactId,
                    "structured_interview",
                    "analyze_answer",
                );
                const resolvedQuestion = interview.questions.find((item) => item.id === input.questionId);
                if (!resolvedQuestion) throw new Error(`问题不存在: ${input.questionId}`);
                const resolvedCluster = interview.clusters.find((item) => item.id === resolvedQuestion.clusterId);
                if (!resolvedCluster) {
                    throw new Error(`问题簇不存在: ${resolvedQuestion.clusterId}`);
                }
                const resolvedClusterQuestions = resolvedCluster.questionIds.map((questionId) => {
                    const item = interview.questions.find((candidate) => candidate.id === questionId);
                    if (!item) throw new Error(`问题簇引用了不存在的问题: ${questionId}`);
                    return item;
                });
                validateInput({
                    question: resolvedQuestion,
                    cluster: resolvedCluster,
                    clusterQuestions: resolvedClusterQuestions,
                });
                question = resolvedQuestion;
                cluster = resolvedCluster;
                clusterQuestions = resolvedClusterQuestions;
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "input_error",
                        message: error instanceof Error ? error.message : "面试结构 Artifact 读取失败",
                    },
                };
            }

            if (ctx.abortSignal.aborted) {
                return {
                    success: false,
                    error: { code: "timeout", message: "操作已中止" },
                };
            }

            const storeAnalysis = (analysis: QuestionAnalysis): AnalyzeAnswerOutput => {
                const payload: QuestionAnalysisArtifact = {
                    structuredInterviewArtifactId: input.structuredInterviewArtifactId,
                    analysis,
                };
                const artifactId = ctx.artifactStore!.put("question_analysis", payload, {
                    producer: "analyze_answer",
                    characterCount: JSON.stringify(payload).length,
                    itemCount: 1,
                });
                return {
                    artifactId,
                    questionId: analysis.questionId,
                    clusterId: analysis.clusterId,
                    status: analysis.status,
                    ...(analysis.status === "completed" && analysis.score !== null ? { score: analysis.score } : {}),
                };
            };

            if (question.questionType === "procedural") {
                const analysis: NotScoredQuestionAnalysis = {
                    status: "not_scored",
                    questionId: question.id,
                    clusterId: question.clusterId,
                };
                return { success: true, data: storeAnalysis(analysis) };
            }

            try {
                const questionIndex = cluster.questionIds.indexOf(question.id);
                const rubric = QUESTION_RUBRICS[question.questionType];
                const applicableDimensions = new Set<SemanticDimension>(rubric.applicableDimensions);
                if (questionIndex > 0) applicableDimensions.add("followUpHandling");

                const expressionStats = collectExpressionStats(question.originalAnswer);
                const response = await queryModelJson({
                    queryEngine: ctx.queryEngine,
                    model,
                    abortSignal: ctx.abortSignal,
                    tracer: ctx.tracer,
                    traceOperation: "analyze_answer",
                    schema: responseSchema,
                    systemPrompt: [
                        "只基于输入分析当前面试回答，严格输出 JSON。",
                        rubric.prompt,
                        `允许评分的语义维度: ${[...applicableDimensions].join(", ")}。`,
                        "不适用的语义维度必须返回 null。",
                        "必须结合原回答和 expressionStats 返回 expressionQuality；统计仅作辅助，不得只按回答长度机械扣分。",
                        "不得返回总分。",
                        "strength 和 issue 只能引用当前问题给出的 promptTurnIds 或 answerTurnIds。",
                        "每个 issue 必须恰好有一个 improvement，且 improvement.issueId 必须引用该 issue。",
                        "clarificationCandidates 只能引用当前问题簇的 questionId。",
                        "JSON 根对象只能包含 strengths、issues、improvements、dimensions、confidence、confidenceReason、clarificationCandidates。",
                        "strengths 和 issues 每项只能包含 id、text、impact、evidenceTurnIds。",
                        "improvements 每项只能包含 issueId、text。",
                        "dimensions 必须包含 contentQuality、depthAndEvidence、analysisAndTradeoffs、followUpHandling、expressionQuality。",
                        "clarificationCandidates 每项只能包含 factKey、question、affectedQuestionIds、impact，其中 impact 只能是 high、medium、low。",
                        "合法 JSON 格式示例：",
                        jsonOutputExample(applicableDimensions),
                        "只返回一个 JSON 对象；不得使用 Markdown 代码块，不得附加解释文字。",
                    ].join("\n"),
                    userContent: JSON.stringify({
                        question,
                        cluster,
                        clusterQuestions,
                        expressionStats,
                    }),
                });

                const allowedTurnIds = new Set([...question.promptTurnIds, ...question.answerTurnIds]);
                validateEvidence([...response.strengths, ...response.issues], allowedTurnIds);
                validateImprovements(response);
                validateDimensions(response.dimensions, applicableDimensions);
                validateClarifications(response.clarificationCandidates, new Set(cluster.questionIds));

                const dimensionScores: DimensionScores = response.dimensions;
                const analysis: CompletedQuestionAnalysis = {
                    status: "completed",
                    questionId: question.id,
                    clusterId: question.clusterId,
                    questionType: question.questionType,
                    strengths: response.strengths,
                    issues: response.issues,
                    improvements: response.improvements,
                    dimensionScores,
                    score: calculateQuestionScore(dimensionScores),
                    confidence: response.confidence,
                    confidenceReason: response.confidenceReason,
                    clarificationCandidates: response.clarificationCandidates,
                };
                return {
                    success: true,
                    data: storeAnalysis(analysis),
                };
            } catch (error) {
                if (isAbortError(error) || ctx.abortSignal.aborted) {
                    return {
                        success: false,
                        error: { code: "timeout", message: "操作已中止" },
                    };
                }
                const failed: FailedQuestionAnalysis = {
                    status: "failed",
                    questionId: question.id,
                    clusterId: question.clusterId,
                    error: safeAnalysisFailureMessage(error),
                };
                return {
                    success: true,
                    data: storeAnalysis(failed),
                };
            }
        },
    };
}
