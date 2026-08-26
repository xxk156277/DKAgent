import type { InterviewQuestionType } from "./types.js";

export type GlobalDimension =
    "contentQuality" | "depthAndEvidence" | "analysisAndTradeoffs" | "followUpHandling" | "expressionQuality";

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

export type QuestionAnalysis = CompletedQuestionAnalysis | FailedQuestionAnalysis | NotScoredQuestionAnalysis;

// export type ProjectFactStatus = "stated" | "inferred" | "unknown";
// export type ProjectFactCategory =
//     | "background"
//     | "responsibility"
//     | "decision"
//     | "implementation"
//     | "metric"
//     | "result";
//
// export interface ProjectFact {
//     key: string;
//     category: ProjectFactCategory;
//     value: string | null;
//     status: ProjectFactStatus;
//     evidenceTurnIds: string[];
//     evidenceQuote: string | null;
//     affectedQuestionIds: string[];
//     clarificationQuestion: string | null;
//     impact: EvidenceImpact;
// }
//
// export interface ProjectFactSet {
//     clusterId: string;
//     facts: ProjectFact[];
//     clarificationCandidates: ClarificationCandidate[];
// }

export interface ExpressionStats {
    /** 识别到的语气词及各自出现次数。 */
    fillerWords: Array<{ word: string; count: number }>;
    /** 语气词总出现次数。 */
    fillerCount: number;
    /** 相邻重复词或短语的出现次数。 */
    adjacentRepetitionCount: number;
    /** 去除空白后的回答字符数。 */
    characterCount: number;
    /** 按句末标点切分得到的句子数。 */
    sentenceCount: number;
    /** 超过程序阈值的长句数量。 */
    longSentenceCount: number;
}

export interface ClusterScore {
    clusterId: string;
    dimensions: DimensionScores;
}

export interface InterviewScore {
    totalScore: number | null;
    dimensions: DimensionScores;
    clusterScores: ClusterScore[];
    coverage: { analyzed: number; expected: number };
}

export interface ReportReferenceItem {
    text: string;
    questionIds: string[];
}

export interface ReportQuestionItem {
    questionId: string;
    originalQuestion: string;
    originalAnswer: string;
    label: string;
    issues: string[];
    improvements: string[];
    score: number | null;
    confidenceLabel: "高" | "中" | "低" | null;
    confidenceReason: string | null;
    status: "completed" | "failed" | "not_scored";
}

export interface InterviewMetadata {
    company: string | null;
    position: string | null;
    date: string | null;
    round: string | null;
}

// export interface JobMatchItem {
//     text: string;
//     jdEvidence: string;
//     questionIds: string[];
// }
//
// export interface JobMatchAnalysis {
//     summary: string;
//     matches: JobMatchItem[];
//     gaps: JobMatchItem[];
// }

export interface InterviewReport {
    stage: "provisional" | "final";
    notice: string | null;
    metadata: InterviewMetadata;
    score: InterviewScore;
    summaryStatus: "completed" | "failed";
    levelSummary: string;
    strengths: ReportReferenceItem[];
    coreIssues: ReportReferenceItem[];
    priorityImprovements: ReportReferenceItem[];
    // jobMatchStatus: "not_provided" | "completed" | "failed";
    // jobMatch: JobMatchAnalysis | null;
    pendingClarifications: ClarificationCandidate[];
    questions: ReportQuestionItem[];
}
