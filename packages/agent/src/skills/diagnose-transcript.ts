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

export interface DiagnoseTranscriptInput {
    transcriptPath: string;
    metadata?: {
        company?: string;
        position?: string;
        date?: string;
        round?: string;
    };
    jdText?: string;
}

export interface DiagnoseTranscriptOutput {
    reportPath: string;
    levelSummary: string;
    totalScore: number;
    analyzedCount: number;
    questionCount: number;
    pendingCount: number;
    jobMatchStatus: "not_provided" | "completed" | "failed";
}

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
                    execute: () => deps.preprocessTool.execute({ transcript }, context),
                    summarizeOutput: (value) => ({
                        success: value.success,
                        correctionCount: value.data?.corrections.length ?? 0,
                    }),
                });
                if (!preprocessed.success || !preprocessed.data) {
                    throw new Error(preprocessed.error?.message ?? "面试稿纠错失败");
                }
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
                    execute: () => deps.generateReportTool.execute({
                        structuredInterview,
                        analyses,
                        projectFactSets,
                        stage: "provisional",
                        ...(input.metadata ? { metadata: input.metadata } : {}),
                        ...(input.jdText ? { jdText: input.jdText } : {}),
                    }, context),
                    summarizeOutput: (value) => ({
                        success: value.success,
                        summaryStatus: value.data?.report.summaryStatus ?? "failed",
                        jobMatchStatus: value.data?.report.jobMatchStatus ?? "failed",
                    }),
                });
                if (!generated.success || !generated.data) {
                    throw new Error(generated.error?.message ?? "报告生成失败");
                }
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
