import type { InterviewQuestionType } from "./types.js";

export type GlobalDimension =
    | "contentQuality"
    | "depthAndEvidence"
    | "analysisAndTradeoffs"
    | "followUpHandling"
    | "expressionQuality";

export type DimensionScores = Record<GlobalDimension, number | null>;
export type EvidenceImpact = "high" | "medium" | "low";

export interface ClarificationCandidate {
    factKey: string;
    question: string;
    affectedQuestionIds: string[];
    impact: EvidenceImpact;
}

export interface AnalysisObservation {
    id: string;
    text: string;
    impact: string;
    evidenceTurnIds: string[];
}

export interface AnalysisImprovement {
    issueId: string;
    text: string;
}

export interface CompletedQuestionAnalysis {
    status: "completed";
    questionId: string;
    clusterId: string;
    questionType: InterviewQuestionType;
    strengths: AnalysisObservation[];
    issues: AnalysisObservation[];
    improvements: AnalysisImprovement[];
    dimensionScores: DimensionScores;
    score: number | null;
    confidence: number;
    confidenceReason: string;
    clarificationCandidates: ClarificationCandidate[];
}

export interface FailedQuestionAnalysis {
    status: "failed";
    questionId: string;
    clusterId: string;
    error: string;
}

export interface NotScoredQuestionAnalysis {
    status: "not_scored";
    questionId: string;
    clusterId: string;
}

export type QuestionAnalysis =
    | CompletedQuestionAnalysis
    | FailedQuestionAnalysis
    | NotScoredQuestionAnalysis;

export type ProjectFactStatus = "stated" | "inferred" | "unknown";
export type ProjectFactCategory =
    | "background"
    | "responsibility"
    | "decision"
    | "implementation"
    | "metric"
    | "result";

export interface ProjectFact {
    key: string;
    category: ProjectFactCategory;
    value: string | null;
    status: ProjectFactStatus;
    evidenceTurnIds: string[];
    affectedQuestionIds: string[];
    clarificationQuestion: string | null;
    impact: EvidenceImpact;
}

export interface ProjectFactSet {
    clusterId: string;
    facts: ProjectFact[];
    clarificationCandidates: ClarificationCandidate[];
}

export interface ExpressionStats {
    fillerWords: Array<{ word: string; count: number }>;
    fillerCount: number;
    adjacentRepetitionCount: number;
    characterCount: number;
    sentenceCount: number;
    longSentenceCount: number;
}

export interface ExpressionAnalysis {
    questionId: string;
    stats: ExpressionStats;
    judgementStatus: "completed" | "failed";
    impact: "none" | "slight" | "significant" | "unknown";
    detail: string;
    evidenceQuotes: string[];
    score: number | null;
    confidence: number;
}

export interface ClusterScore {
    clusterId: string;
    dimensions: DimensionScores;
}

export interface InterviewScore {
    totalScore: number;
    dimensions: DimensionScores;
    clusterScores: ClusterScore[];
    coverage: { analyzed: number; expected: number };
}
