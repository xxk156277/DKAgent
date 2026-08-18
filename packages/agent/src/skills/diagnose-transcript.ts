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
                // ① 读取面试稿文件并解析为结构化轮次（speaker/turn）。
                const source = await readWholeText(
                    deps.readFileTool,
                    input.transcriptPath,
                    context,
                );
                const transcript = parseTranscript(source.content);

                // ② 纠错：识别高置信转写错误，得到纠正后的轮次文本。
                const preprocessed = await deps.preprocessTool.execute({ transcript }, context);
                if (!preprocessed.success || !preprocessed.data) {
                    throw new Error(preprocessed.error?.message ?? "面试稿纠错失败");
                }

                // ③ 结构化：把轮次聚类成"问题簇 + 问题列表"，确定每题的题型。
                const relation = await structureInterview({
                    transcript,
                    correctedTurns: preprocessed.data.correctedTurns,
                    queryEngine: context.queryEngine,
                    model: deps.model,
                    abortSignal: context.abortSignal,
                });
                const structuredInterview: StructuredInterview = {
                    transcript,
                    corrections: preprocessed.data.corrections,
                    ...relation,
                };

                // ④ 项目事实：只对包含"项目题"的簇提取项目事实，供后续逐题分析引用。
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

                // ⑤ 逐题分析：对每一题先做表达判断，再做答案分析；失败时记录失败项而不中断整条流程。
                const analyses: QuestionAnalysis[] = [];
                for (const question of relation.questions) {
                    const cluster = relation.clusters.find((item) => item.id === question.clusterId)!;
                    const clusterQuestions = relation.questions.filter(
                        (item) => item.clusterId === question.clusterId,
                    );
                    // 表达分析默认用兜底结果；非流程题才真正调用表达分析工具。
                    let expression = failedExpression(question.id, question.originalAnswer);
                    let references: string[] = [];
                    if (question.questionType !== "procedural") {
                        const result = await deps.analyzeExpressionTool.execute({
                            questionId: question.id,
                            answer: question.originalAnswer,
                        }, context);
                        if (result.success && result.data) expression = result.data;
                        // 知识题额外检索参考材料，供答案分析引用。
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
                        expression,
                        references,
                    }, context);
                    // 单题失败只记一条失败项，不让整条流水线中断。
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

                // ⑥ 汇总生成报告（含总分、等级、待澄清项等）。
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
                // ⑦ 把 Markdown 报告写到带时间戳的文件，拿到可回传给用户的路径。
                const reportPath = await writeTimestampedInterviewReport({
                    tool: deps.writeFileTool,
                    transcriptPath: source.path,
                    markdown: generated.data.markdown,
                    context,
                    now: deps.now?.() ?? new Date(),
                });
                const { report } = generated.data;
                // ⑧ 返回精简摘要（不把整篇报告塞给模型，只给关键指标和路径）。
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
