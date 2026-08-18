import { collectExpressionStats } from "../interview/expression-statistics.js";
import { structureInterview } from "../interview/structurer.js";
import { parseTranscript } from "../interview/transcript-parser.js";
import type {
    ExpressionAnalysis,
    FailedQuestionAnalysis,
    ProjectFactSet,
    QuestionAnalysis,
} from "../interview/analysis-types.js";
import type { StructuredInterview } from "../interview/types.js";
import type { AnalyzeAnswerInput } from "../tools/tool-item/analyze-answer.js";
import type { AnalyzeExpressionInput } from "../tools/tool-item/analyze-expression.js";
import type { ExtractProjectFactsInput } from "../tools/tool-item/extract-project-facts.js";
import type {
    GenerateReportInput,
    GenerateReportOutput,
} from "../tools/tool-item/generate-report.js";
import type {
    PreprocessTranscriptInput,
    PreprocessTranscriptOutput,
} from "../tools/tool-item/preprocess-transcript.js";
import type { ReadFileInput, ReadFileOutput } from "../tools/filesystem/read-file.js";
import type { WriteFileInput, WriteFileOutput } from "../tools/filesystem/write-file.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { readWholeText, writeTimestampedInterviewReport } from "./interview-file-io.js";
import type { InterviewReferenceRetriever } from "./interview-reference-retriever.js";
import { observeSkillOperation } from "./skill-trace.js";

/**
 * 面试稿诊断 Skill 的输入。
 * 这是暴露给模型的对外工具入参（由 analyze_interview 包装后下发）。
 */
export interface DiagnoseTranscriptInput {
    /** 面试稿文本文件路径。 */
    transcriptPath: string;
    /** 可选元数据：公司、职位、日期、轮次，用于报告头部展示。 */
    metadata?: {
        company?: string;
        position?: string;
        date?: string;
        round?: string;
    };
    /** 可选 JD 文本，用于岗位匹配度分析。 */
    jdText?: string;
}

/** 诊断完成后返回给模型的结果摘要。 */
export interface DiagnoseTranscriptOutput {
    reportPath: string;
    levelSummary: string;
    totalScore: number;
    analyzedCount: number;
    questionCount: number;
    pendingCount: number;
    jobMatchStatus: "not_provided" | "completed" | "failed";
}

/**
 * Skill 依赖注入：所有底层能力由外部传入，Skill 本身不 new 任何东西。
 * 其中 5 个 LLM 原子工具（preprocess、extract、analyze 系列、generate）只被本 Skill 持有，
 * 不注册进公共 ToolRegistry，由本 Skill 负责编排调用顺序。
 */
export interface DiagnoseTranscriptDependencies {
    model: string;
    readFileTool: Tool<ReadFileInput, ReadFileOutput>;
    writeFileTool: Tool<WriteFileInput, WriteFileOutput>;
    preprocessTool: Tool<PreprocessTranscriptInput, PreprocessTranscriptOutput>;
    extractProjectFactsTool: Tool<ExtractProjectFactsInput, ProjectFactSet>;
    analyzeExpressionTool: Tool<AnalyzeExpressionInput, ExpressionAnalysis>;
    analyzeAnswerTool: Tool<AnalyzeAnswerInput, QuestionAnalysis>;
    generateReportTool: Tool<GenerateReportInput, GenerateReportOutput>;
    referenceRetriever?: InterviewReferenceRetriever;
    now?: () => Date;
}

/** 表达分析失败时的兜底结果：保留基础统计，标记为 failed，不阻塞后续逐题分析。 */
function failedExpression(questionId: string, answer: string): ExpressionAnalysis {
    return {
        questionId,
        stats: collectExpressionStats(answer),
        judgementStatus: "failed",
        impact: "unknown",
        detail: "表达判断失败。",
        evidenceQuotes: [],
        score: null,
        confidence: 0,
    };
}

/**
 * 面试稿诊断 Skill 工厂。
 * 本身也是一个"Tool"形状（name + execute），但它不做事，而是把
 * 读文件 → 纠错 → 结构化 → 提取项目事实 → 逐题分析 → 生成报告 → 写文件
 * 这一整条流水线编排起来。
 */
export function createDiagnoseTranscriptSkill(deps: DiagnoseTranscriptDependencies) {
    return {
        name: "diagnose-transcript",
        async execute(
            input: DiagnoseTranscriptInput,
            context: ToolContext,
        ): Promise<ToolResult<DiagnoseTranscriptOutput>> {
            try {
                return await observeSkillOperation({
                    context,
                    name: "skill.run",
                    operation: "diagnose-transcript",
                    traceInput: { transcriptPath: input.transcriptPath },
                    execute: async () => {
                        const source = await observeSkillOperation({
                            context,
                            name: "skill.stage",
                            operation: "read_transcript",
                            traceInput: { transcriptPath: input.transcriptPath },
                            execute: () => readWholeText(
                                deps.readFileTool,
                                input.transcriptPath,
                                context,
                            ),
                            summarizeOutput: (value) => ({
                                path: value.path,
                                characterCount: value.content.length,
                            }),
                        });
                        const transcript = parseTranscript(source.content);
                        const preprocessed = await observeSkillOperation({
                            context,
                            name: "skill.stage",
                            operation: "preprocess_transcript",
                            traceInput: { turnCount: transcript.turns.length },
                            execute: async () => {
                                const result = await deps.preprocessTool.execute({ transcript }, context);
                                if (!result.success || !result.data) {
                                    throw new Error(result.error?.message ?? "面试稿纠错失败");
                                }
                                return result as ToolResult<PreprocessTranscriptOutput> & {
                                    data: PreprocessTranscriptOutput;
                                };
                            },
                            summarizeOutput: (value) => ({
                                success: value.success,
                                correctionCount: value.data?.corrections.length ?? 0,
                            }),
                        });
                        const relation = await observeSkillOperation({
                            context,
                            name: "skill.stage",
                            operation: "structure_interview",
                            traceInput: { turnCount: transcript.turns.length },
                            execute: () => structureInterview({
                                transcript,
                                correctedTurns: preprocessed.data!.correctedTurns,
                                queryEngine: context.queryEngine,
                                model: deps.model,
                                abortSignal: context.abortSignal,
                                tracer: context.tracer,
                            }),
                            summarizeOutput: (value) => ({
                                clusterCount: value.clusters.length,
                                questionCount: value.questions.length,
                            }),
                        });
                        const structuredInterview: StructuredInterview = {
                            transcript,
                            corrections: preprocessed.data.corrections,
                            ...relation,
                        };

                        const projectFactSets: ProjectFactSet[] = [];
                        for (const cluster of relation.clusters) {
                            const clusterQuestions = relation.questions.filter(
                                (question) => question.clusterId === cluster.id,
                            );
                            if (!clusterQuestions.some((question) => question.questionType === "project")) {
                                continue;
                            }
                            const result = await observeSkillOperation({
                                context,
                                name: "skill.stage",
                                operation: "extract_project_facts",
                                traceInput: {
                                    clusterId: cluster.id,
                                    questionCount: clusterQuestions.length,
                                },
                                execute: () => deps.extractProjectFactsTool.execute({
                                    transcript,
                                    cluster,
                                    questions: relation.questions,
                                }, context),
                                summarizeOutput: (value) => ({
                                    success: value.success,
                                    factCount: value.data?.facts.length ?? 0,
                                }),
                            });
                            if (result.success && result.data) projectFactSets.push(result.data);
                        }

                        const analyses: QuestionAnalysis[] = [];
                        for (const question of relation.questions) {
                            const cluster = relation.clusters.find((item) => item.id === question.clusterId)!;
                            const clusterQuestions = relation.questions.filter(
                                (item) => item.clusterId === question.clusterId,
                            );
                            let expression = failedExpression(question.id, question.originalAnswer);
                            let references: string[] = [];
                            if (question.questionType !== "procedural") {
                                const result = await observeSkillOperation({
                                    context,
                                    name: "skill.stage",
                                    operation: "analyze_expression",
                                    traceInput: { questionId: question.id },
                                    execute: () => deps.analyzeExpressionTool.execute({
                                        questionId: question.id,
                                        answer: question.originalAnswer,
                                    }, context),
                                    summarizeOutput: (value) => ({
                                        success: value.success,
                                        judgementStatus: value.data?.judgementStatus ?? "failed",
                                    }),
                                });
                                if (result.success && result.data) expression = result.data;
                                if (question.questionType === "knowledge" && deps.referenceRetriever) {
                                    try {
                                        references = await observeSkillOperation({
                                            context,
                                            name: "skill.stage",
                                            operation: "retrieve_reference",
                                            traceInput: { questionId: question.id },
                                            execute: () => deps.referenceRetriever!.search(question.originalQuestion),
                                            summarizeOutput: (value) => ({ referenceCount: value.length }),
                                        });
                                    } catch {
                                        references = [];
                                    }
                                }
                            }
                            const result = await observeSkillOperation({
                                context,
                                name: "skill.stage",
                                operation: "analyze_answer",
                                traceInput: { questionId: question.id, clusterId: cluster.id },
                                execute: () => deps.analyzeAnswerTool.execute({
                                    question,
                                    cluster,
                                    clusterQuestions,
                                    projectFacts: projectFactSets.find((item) => item.clusterId === cluster.id) ?? null,
                                    expression,
                                    references,
                                }, context),
                                summarizeOutput: (value) => ({
                                    success: value.success,
                                    analysisStatus: value.data?.status ?? "failed",
                                }),
                            });
                            if (result.success && result.data) {
                                analyses.push(result.data);
                            } else {
                                const failed: FailedQuestionAnalysis = {
                                    status: "failed",
                                    questionId: question.id,
                                    clusterId: question.clusterId,
                                    error: result.error?.message ?? "逐题分析失败",
                                };
                                analyses.push(failed);
                            }
                        }

                        const generated = await observeSkillOperation({
                            context,
                            name: "skill.stage",
                            operation: "generate_report",
                            traceInput: {
                                questionCount: relation.questions.length,
                                hasJd: Boolean(input.jdText?.trim()),
                            },
                            execute: async () => {
                                const result = await deps.generateReportTool.execute({
                                    structuredInterview,
                                    analyses,
                                    projectFactSets,
                                    stage: "provisional",
                                    ...(input.metadata ? { metadata: input.metadata } : {}),
                                    ...(input.jdText ? { jdText: input.jdText } : {}),
                                }, context);
                                if (!result.success || !result.data) {
                                    throw new Error(result.error?.message ?? "报告生成失败");
                                }
                                return result as ToolResult<GenerateReportOutput> & {
                                    data: GenerateReportOutput;
                                };
                            },
                            summarizeOutput: (value) => ({
                                success: value.success,
                                summaryStatus: value.data?.report.summaryStatus ?? "failed",
                                jobMatchStatus: value.data?.report.jobMatchStatus ?? "failed",
                            }),
                        });
                        const reportPath = await observeSkillOperation({
                            context,
                            name: "skill.stage",
                            operation: "write_report",
                            traceInput: { transcriptPath: source.path },
                            execute: () => writeTimestampedInterviewReport({
                                tool: deps.writeFileTool,
                                transcriptPath: source.path,
                                markdown: generated.data!.markdown,
                                context,
                                now: deps.now?.() ?? new Date(),
                            }),
                            summarizeOutput: (value) => ({
                                reportPath: value,
                                characterCount: generated.data!.markdown.length,
                            }),
                        });
                        const { report } = generated.data;
                        return {
                            success: true,
                            data: {
                                reportPath,
                                levelSummary: report.summaryStatus === "completed"
                                    ? report.levelSummary
                                    : "汇总失败；请查看逐题分析。",
                                totalScore: report.score.totalScore,
                                analyzedCount: report.score.coverage.analyzed,
                                questionCount: report.questions.length,
                                pendingCount: report.pendingClarifications.length,
                                jobMatchStatus: report.jobMatchStatus,
                            },
                        };
                    },
                    summarizeOutput: (value) => ({
                        success: value.success,
                        ...(value.data ? { reportPath: value.data.reportPath } : {}),
                    }),
                });
            } catch (error) {
                // ⑨ 任何一步抛错统一收敛为 service_error，不让异常冒泡到 Agent 循环。
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: error instanceof Error ? error.message : "面试分析失败",
                    },
                };
            }
        },
    };
}
