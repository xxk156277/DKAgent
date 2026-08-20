import { collectExpressionStats } from "../interview/expression-statistics.js";
import { structureInterview } from "../interview/structurer.js";
import { parseTranscript } from "../interview/transcript-parser.js";
import type {
    FailedQuestionAnalysis,
    ProjectFactSet,
    QuestionAnalysis,
} from "../interview/analysis-types.js";
import type { StructuredInterview } from "../interview/types.js";
import type { AnalyzeAnswerInput } from "../tools/tool-item/analyze-answer.js";
import type { ExtractProjectFactsInput } from "../tools/tool-item/extract-project-facts.js";
import type {
    GenerateReportInput,
    GenerateReportOutput,
} from "../tools/tool-item/generate-report.js";
import type { ReadFileInput, ReadFileOutput } from "../tools/filesystem/read-file.js";
import type { WriteFileInput, WriteFileOutput } from "../tools/filesystem/write-file.js";
import type { Tool, ToolContext, ToolResult } from "../tools/types.js";
import { readWholeText, writeTimestampedInterviewReport } from "./interview-file-io.js";
import type { InterviewReferenceRetriever } from "./interview-reference-retriever.js";

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
    extractProjectFactsTool: Tool<ExtractProjectFactsInput, ProjectFactSet>;
    analyzeAnswerTool: Tool<AnalyzeAnswerInput, QuestionAnalysis>;
    generateReportTool: Tool<GenerateReportInput, GenerateReportOutput>;
    referenceRetriever?: InterviewReferenceRetriever;
    now?: () => Date;
}

export function createDiagnoseTranscriptSkill(deps: DiagnoseTranscriptDependencies) {
    return {
        name: "diagnose-transcript",
        async execute(
            input: DiagnoseTranscriptInput,
            context: ToolContext,
        ): Promise<ToolResult<DiagnoseTranscriptOutput>> {
            try {
                const source = await readWholeText(
                    deps.readFileTool,
                    input.transcriptPath,
                    context,
                );
                const transcript = parseTranscript(source.content);
                const relation = await structureInterview({
                    transcript,
                    queryEngine: context.queryEngine,
                    model: deps.model,
                    abortSignal: context.abortSignal,
                });
                const structuredInterview: StructuredInterview = {
                    transcript,
                    corrections: [],
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
                    const result = await deps.extractProjectFactsTool.execute({
                        transcript,
                        cluster,
                        questions: relation.questions,
                    }, context);
                    if (result.success && result.data) projectFactSets.push(result.data);
                }

                const analyses: QuestionAnalysis[] = [];
                for (const question of relation.questions) {
                    const cluster = relation.clusters.find((item) => item.id === question.clusterId)!;
                    const clusterQuestions = relation.questions.filter(
                        (item) => item.clusterId === question.clusterId,
                    );
                    let references: string[] = [];
                    if (question.questionType !== "procedural") {
                        if (question.questionType === "knowledge" && deps.referenceRetriever) {
                            try {
                                references = await deps.referenceRetriever.search(question.originalQuestion);
                            } catch {
                                references = [];
                            }
                        }
                    }
                    const result = await deps.analyzeAnswerTool.execute({
                        question,
                        cluster,
                        clusterQuestions,
                        projectFacts: projectFactSets.find((item) => item.clusterId === cluster.id) ?? null,
                        expressionStats: collectExpressionStats(question.originalAnswer),
                        references,
                    }, context);
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

                const generated = await deps.generateReportTool.execute({
                    structuredInterview,
                    analyses,
                    projectFactSets,
                    stage: "provisional",
                    ...(input.metadata ? { metadata: input.metadata } : {}),
                    ...(input.jdText ? { jdText: input.jdText } : {}),
                }, context);
                if (!generated.success || !generated.data) {
                    throw new Error(generated.error?.message ?? "报告生成失败");
                }
                const reportPath = await writeTimestampedInterviewReport({
                    tool: deps.writeFileTool,
                    transcriptPath: source.path,
                    markdown: generated.data.markdown,
                    context,
                    now: deps.now?.() ?? new Date(),
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
