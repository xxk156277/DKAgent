import type { QuestionAnalysis } from "./analysis-types.js";

/** question_analysis Artifact 的存储包装；领域分析对象不承担 Artifact 来源信息。 */
export interface QuestionAnalysisArtifact {
    structuredInterviewArtifactId: string;
    analysis: QuestionAnalysis;
}
