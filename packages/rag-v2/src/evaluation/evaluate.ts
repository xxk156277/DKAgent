import fs from "node:fs/promises";
import { z } from "zod";
import type { EvaluationQuestion } from "../domain/types.js";
import { EmbeddingService } from "../embedding/embedding.js";
import { askKnowledgeBase, type AskStatus } from "../generation/ask.js";
import { searchKnowledge } from "../retrieval/search.js";
import { RagDatabase } from "../storage/database.js";

/** 评估用例的校验 Schema（读取 JSONL 时逐行校验）。 */
const QuestionSchema = z.object({
    query: z.string().min(1),
    relevantSourcePaths: z.array(z.string()),
    expectedFacts: z.array(z.string()).default([]),
    shouldRefuse: z.boolean(),
}).superRefine((question, context) => {
    if (!question.shouldRefuse && question.relevantSourcePaths.length === 0) {
        context.addIssue({
            code: "custom",
            path: ["relevantSourcePaths"],
            message: "可回答问题必须至少标注一篇相关父文档",
        });
    }
});

/**
 * 按标准定义计算单题 Recall@K：Top-K 命中的相关文档数 / 全部相关文档数。
 */
export function calculateRecallAtK(relevantSourcePaths: string[], returnedPaths: string[]): {
    recallAtK: number;
    matchedRelevantPaths: string[];
} {
    const relevantPaths = [...new Set(relevantSourcePaths)];
    const returnedPathSet = new Set(returnedPaths);
    const matchedRelevantPaths = relevantPaths.filter((sourcePath) => returnedPathSet.has(sourcePath));
    return {
        recallAtK: relevantPaths.length === 0 ? 0 : matchedRelevantPaths.length / relevantPaths.length,
        matchedRelevantPaths,
    };
}

/**
 * 读取 JSONL 格式的评估用例文件，逐行解析并校验。
 */
export async function readEvaluationQuestions(filePath: string): Promise<EvaluationQuestion[]> {
    const content = await fs.readFile(filePath, "utf8");
    return content
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
            try {
                return QuestionSchema.parse(JSON.parse(line));
            } catch (error) {
                throw new Error(
                    `评估文件第 ${index + 1} 行无效：${error instanceof Error ? error.message : String(error)}`,
                );
            }
            /**
             * 检索评估报告：总量、可答数、Recall@3、平均延迟，以及建议相似度阈值。
             */
        });
}

export interface EvaluationReport {
    total: number;
    answerable: number;
    recallAt3: number;
    averageLatencyMs: number;
    embeddingTokens?: number | undefined;
    suggestedThreshold?: number | undefined;
    thresholdOverlap: boolean;
    cases: Array<{
        query: string;
        expectedFacts: string[];
        shouldRefuse: boolean;
        recallAt3: number | null;
        matchedRelevantPaths: string[];
        topScore?: number | undefined;
        returnedPaths: string[];
        latencyMs: number;
        /**
         * 逐条执行检索评估：统计召回率与延迟，并基于正例 / 拒答例的相似度分布
         * 推断可区分的相似度阈值（分布重叠时置 thresholdOverlap，不给出建议值）。
         */
    }>;
}

/** 完整问答基线汇总所需的最小逐题字段。 */
export interface AnswerSummaryCase {
    shouldRefuse: boolean;
    status: AskStatus;
    refusalReason?: string | undefined;
    factCoverage: number | null;
    citationSupported: boolean | null;
    latencyMs: number;
    usage: {
        embeddingTokens?: number | undefined;
        generationTokens?: number | undefined;
        verificationTokens?: number | undefined;
    };
}

/** 汇总正例事实覆盖 / 引用支持和负例拒答准确率。 */
export function summarizeAnswerCases(cases: AnswerSummaryCase[]): {
    answerCompleteness: number;
    citationSupportRate: number;
    refusalAccuracy: number;
    verificationFailureCount: number;
    averageLatencyMs: number;
    usage: { embeddingTokens: number; generationTokens: number; verificationTokens: number };
} {
    const answerable = cases.filter((item) => !item.shouldRefuse);
    const refusal = cases.filter((item) => item.shouldRefuse);
    const factCases = answerable.filter(
        (item): item is AnswerSummaryCase & { factCoverage: number } => item.factCoverage !== null,
    );
    const citationCases = answerable.filter(
        (item): item is AnswerSummaryCase & { citationSupported: boolean } => item.citationSupported !== null,
    );
    return {
        answerCompleteness:
            factCases.length === 0 ? 0 : factCases.reduce((sum, item) => sum + item.factCoverage, 0) / factCases.length,
        citationSupportRate:
            citationCases.length === 0
                ? 0
                : citationCases.filter((item) => item.citationSupported).length / citationCases.length,
        refusalAccuracy:
            refusal.length === 0
                ? 0
                : refusal.filter(
                      (item) => item.status === "refused" && item.refusalReason !== "citation_verification_failed",
                  ).length / refusal.length,
        verificationFailureCount: cases.filter((item) => item.refusalReason === "citation_verification_failed").length,
        averageLatencyMs:
            cases.length === 0 ? 0 : Math.round(cases.reduce((sum, item) => sum + item.latencyMs, 0) / cases.length),
        usage: cases.reduce(
            (total, item) => ({
                embeddingTokens: total.embeddingTokens + (item.usage.embeddingTokens ?? 0),
                generationTokens: total.generationTokens + (item.usage.generationTokens ?? 0),
                verificationTokens: total.verificationTokens + (item.usage.verificationTokens ?? 0),
            }),
            { embeddingTokens: 0, generationTokens: 0, verificationTokens: 0 },
        ),
    };
}

/** 完整问答基线报告。 */
export interface AnswerEvaluationReport extends ReturnType<typeof summarizeAnswerCases> {
    total: number;
    answerable: number;
    refusalCases: number;
    recallAt3: number;
    cases: Array<AnswerSummaryCase & {
        query: string;
        expectedFacts: string[];
        returnedPaths: string[];
        recallAt3: number | null;
        answer: string;
        draftAnswer?: string | undefined;
        coveredFactIndexes: number[];
        unsupportedClaims: string[];
    }>;
}

export async function evaluateRetrieval(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    questions: EvaluationQuestion[];
    strategy?: "dense" | "hybrid" | undefined;
}): Promise<EvaluationReport> {
    const cases: EvaluationReport["cases"] = [];
    const positiveScores: number[] = [];
    const refusalScores: number[] = [];
    let embeddingTokens = 0;
    let hasUsage = false;
    for (const question of input.questions) {
        const result = await searchKnowledge({
            database: input.database,
            embedding: input.embedding,
            query: question.query,
            topK: 3,
            strategy: input.strategy ?? "hybrid",
        });
        const returnedPaths = result.hits.map((hit) => hit.sourcePath);
        if (result.embeddingTokens !== undefined) {
            embeddingTokens += result.embeddingTokens;
            hasUsage = true;
        }
        const recall = question.shouldRefuse
            ? { recallAtK: null, matchedRelevantPaths: [] }
            : calculateRecallAtK(question.relevantSourcePaths, returnedPaths);
        const topScore = result.hits[0]?.similarity;
        if (topScore !== undefined) {
            (question.shouldRefuse ? refusalScores : positiveScores).push(topScore);
        }
        cases.push({
            query: question.query,
            expectedFacts: question.expectedFacts,
            shouldRefuse: question.shouldRefuse,
            recallAt3: recall.recallAtK,
            matchedRelevantPaths: recall.matchedRelevantPaths,
            topScore,
            returnedPaths,
            latencyMs: result.durationMs,
        });
    }
    const answerableCases = cases.filter(
        (evaluationCase): evaluationCase is typeof evaluationCase & { recallAt3: number } =>
            evaluationCase.recallAt3 !== null,
    );
    const lowestPositive = positiveScores.length ? Math.min(...positiveScores) : undefined;
    const highestRefusal = refusalScores.length ? Math.max(...refusalScores) : undefined;
    const thresholdOverlap =
        lowestPositive !== undefined && highestRefusal !== undefined ? highestRefusal >= lowestPositive : false;
    const suggestedThreshold =
        lowestPositive !== undefined && highestRefusal !== undefined && !thresholdOverlap
            ? (lowestPositive + highestRefusal) / 2
            : undefined;
    return {
        total: cases.length,
        answerable: answerableCases.length,
        recallAt3:
            answerableCases.length === 0
                ? 0
                : answerableCases.reduce((sum, evaluationCase) => sum + evaluationCase.recallAt3, 0) /
                  answerableCases.length,
        averageLatencyMs:
            cases.length === 0 ? 0 : Math.round(cases.reduce((sum, item) => sum + item.latencyMs, 0) / cases.length),
        embeddingTokens: hasUsage ? embeddingTokens : undefined,
        suggestedThreshold,
        thresholdOverlap,
        cases,
    };
}

/** 串行运行完整问答，避免并发放大模型调用和速率限制。 */
export async function evaluateAnswers(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    questions: EvaluationQuestion[];
    generation: { apiKey: string; baseUrl: string; model: string };
    minSimilarity?: number | undefined;
}): Promise<AnswerEvaluationReport> {
    const cases: AnswerEvaluationReport["cases"] = [];
    for (const question of input.questions) {
        const result = await askKnowledgeBase({
            database: input.database,
            embedding: input.embedding,
            query: question.query,
            generation: input.generation,
            minSimilarity: input.minSimilarity,
            expectedFacts: question.expectedFacts,
        });
        const returnedPaths = result.hits.map((hit) => hit.sourcePath);
        const recall = question.shouldRefuse
            ? { recallAtK: null, matchedRelevantPaths: [] }
            : calculateRecallAtK(question.relevantSourcePaths, returnedPaths);
        const coveredFactIndexes = result.verification?.coveredFactIndexes ?? [];
        const factCoverage = question.shouldRefuse
            ? null
            : question.expectedFacts.length === 0
              ? null
              : coveredFactIndexes.length / question.expectedFacts.length;
        cases.push({
            query: question.query,
            expectedFacts: question.expectedFacts,
            shouldRefuse: question.shouldRefuse,
            status: result.status,
            refusalReason: result.refusalReason,
            answer: result.answer,
            draftAnswer: result.draftAnswer,
            factCoverage,
            citationSupported: question.shouldRefuse ? null : (result.verification?.citationSupported ?? false),
            returnedPaths,
            recallAt3: recall.recallAtK,
            coveredFactIndexes,
            unsupportedClaims: result.verification?.unsupportedClaims ?? [],
            latencyMs: result.durationMs,
            usage: {
                embeddingTokens: result.usage.embeddingTokens,
                generationTokens: result.usage.generationTokens,
                verificationTokens: result.usage.verificationTokens,
            },
        });
    }
    const summary = summarizeAnswerCases(cases);
    const answerableCases = cases.filter(
        (item): item is typeof item & { recallAt3: number } => item.recallAt3 !== null,
    );
    return {
        total: cases.length,
        answerable: answerableCases.length,
        refusalCases: cases.length - answerableCases.length,
        recallAt3:
            answerableCases.length === 0
                ? 0
                : answerableCases.reduce((sum, item) => sum + item.recallAt3, 0) / answerableCases.length,
        ...summary,
        cases,
    };
}
