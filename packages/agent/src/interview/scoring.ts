import type {
    CompletedQuestionAnalysis,
    DimensionScores,
    GlobalDimension,
    InterviewScore,
    QuestionAnalysis,
} from "./analysis-types.js";
import type { InterviewQuestion, QuestionCluster } from "./types.js";

export const DIMENSION_WEIGHTS: Record<GlobalDimension, number> = {
    contentQuality: 0.25,
    depthAndEvidence: 0.25,
    analysisAndTradeoffs: 0.2,
    followUpHandling: 0.15,
    expressionQuality: 0.15,
};

const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as GlobalDimension[];

function mean(values: number[]): number | null {
    return values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : null;
}

function round(value: number | null): number | null {
    return value === null ? null : Math.round(value);
}

export function calculateQuestionScore(scores: DimensionScores): number | null {
    let weighted = 0;
    let weights = 0;
    for (const dimension of DIMENSIONS) {
        const score = scores[dimension];
        if (score === null) continue;
        if (!Number.isFinite(score) || score < 0 || score > 100) {
            throw new Error(`维度分数越界: ${dimension}`);
        }
        weighted += score * DIMENSION_WEIGHTS[dimension];
        weights += DIMENSION_WEIGHTS[dimension];
    }
    return weights ? Math.round(weighted / weights) : null;
}

export function scoreInterview(input: {
    questions: InterviewQuestion[];
    clusters: QuestionCluster[];
    analyses: QuestionAnalysis[];
}): InterviewScore {
    const scoredQuestionIds = new Set(
        input.questions
            .filter((question) => question.scored)
            .map((question) => question.id),
    );
    const completed = input.analyses.filter(
        (item): item is CompletedQuestionAnalysis => item.status === "completed"
            && scoredQuestionIds.has(item.questionId),
    );
    const completedByQuestion = new Map(
        completed.map((item) => [item.questionId, item]),
    );
    const clusterScores = input.clusters.flatMap((cluster) => {
        const items = cluster.questionIds
            .map((questionId) => completedByQuestion.get(questionId))
            .filter((item) => item !== undefined);
        if (!items.length) return [];
        const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
            dimension,
            round(mean(items.flatMap((item) => {
                const value = item.dimensionScores[dimension];
                return value === null ? [] : [value];
            }))),
        ])) as DimensionScores;
        return [{ clusterId: cluster.id, dimensions }];
    });
    const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
        dimension,
        round(mean(clusterScores.flatMap((cluster) => {
            const value = cluster.dimensions[dimension];
            return value === null ? [] : [value];
        }))),
    ])) as DimensionScores;
    const totalScore = calculateQuestionScore(dimensions);
    if (totalScore === null) throw new Error("没有可评分维度");
    return {
        totalScore,
        dimensions,
        clusterScores,
        coverage: {
            analyzed: completed.length,
            expected: scoredQuestionIds.size,
        },
    };
}
