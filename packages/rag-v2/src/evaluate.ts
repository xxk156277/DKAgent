import fs from "node:fs/promises";
import { z } from "zod";
import { RagDatabase } from "./database.js";
import { EmbeddingService } from "./embedding.js";
import { searchKnowledge } from "./search.js";
import type { EvaluationQuestion } from "./types.js";

/** 评估用例的校验 Schema（读取 JSONL 时逐行校验）。 */
const QuestionSchema = z.object({
    query: z.string().min(1),
    relevantSourcePaths: z.array(z.string()),
    expectedFacts: z.array(z.string()).default([]),
    shouldRefuse: z.boolean(),
});

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
    embeddingTokens?: number;
    suggestedThreshold?: number;
    thresholdOverlap: boolean;
    cases: Array<{
        query: string;
        expectedFacts: string[];
        shouldRefuse: boolean;
        recalled: boolean;
        topScore?: number;
        returnedPaths: string[];
        latencyMs: number;
        /**
         * 逐条执行检索评估：统计召回率与延迟，并基于正例 / 拒答例的相似度分布
         * 推断可区分的相似度阈值（分布重叠时置 thresholdOverlap，不给出建议值）。
         */
    }>;
}

export async function evaluateRetrieval(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    questions: EvaluationQuestion[];
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
        });
        const returnedPaths = result.hits.map((hit) => hit.sourcePath);
        if (result.embeddingTokens !== undefined) {
            embeddingTokens += result.embeddingTokens;
            hasUsage = true;
        }
        const recalled = question.shouldRefuse
            ? true
            : question.relevantSourcePaths.some((sourcePath) => returnedPaths.includes(sourcePath));
        const topScore = result.hits[0]?.similarity;
        if (topScore !== undefined) {
            (question.shouldRefuse ? refusalScores : positiveScores).push(topScore);
        }
        cases.push({
            query: question.query,
            expectedFacts: question.expectedFacts,
            shouldRefuse: question.shouldRefuse,
            recalled,
            topScore,
            returnedPaths,
            latencyMs: result.durationMs,
        });
    }
    const answerableCases = cases.filter((_, index) => !input.questions[index]!.shouldRefuse);
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
                : answerableCases.filter((evaluationCase) => evaluationCase.recalled).length / answerableCases.length,
        averageLatencyMs:
            cases.length === 0 ? 0 : Math.round(cases.reduce((sum, item) => sum + item.latencyMs, 0) / cases.length),
        embeddingTokens: hasUsage ? embeddingTokens : undefined,
        suggestedThreshold,
        thresholdOverlap,
        cases,
    };
}
