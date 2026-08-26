import type { GlobalDimension } from "./analysis-types.js";
import type { InterviewQuestionType } from "./types.js";

export interface QuestionRubric {
    prompt: string;
    applicableDimensions: Array<Exclude<GlobalDimension, "expressionQuality">>;
}

export const QUESTION_RUBRICS: Record<Exclude<InterviewQuestionType, "procedural">, QuestionRubric> = {
    project: {
        prompt: "评价项目背景、本人职责、决策依据、实施细节、结果证据和追问一致性，不与标准答案比较。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    knowledge: {
        // prompt: "评价技术事实、关键知识点和原理深度；只有提供参考资料时才据其核验。",
        prompt: "只基于当前问题和原回答，评价技术事实、关键知识点和原理深度；没有外部资料时不得假装完成资料核验。",
        applicableDimensions: ["contentQuality", "depthAndEvidence"],
    },
    open: {
        prompt: "评价问题澄清、约束、拆解、权衡、风险和验证。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    behavior: {
        prompt: "评价情境、个人行动、协作方式、结果和复盘。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    coding: {
        prompt: "评价思路、实际产出、样例验证、边界和复杂度。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
};
