import { z } from "zod";
import type { ExpressionAnalysis } from "../../interview/analysis-types.js";
import { collectExpressionStats } from "../../interview/expression-statistics.js";
import { queryModelJson } from "../../interview/model-json.js";
import type { Tool } from "../types.js";

const judgementSchema = z.object({
    impact: z.enum(["none", "slight", "significant"]),
    detail: z.string().min(1),
    evidenceQuotes: z.array(z.string().min(1)),
    score: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
}).strict();

export interface AnalyzeExpressionInput {
    questionId: string;
    answer: string;
}

function failedAnalysis(input: AnalyzeExpressionInput): ExpressionAnalysis {
    return {
        questionId: input.questionId,
        stats: collectExpressionStats(input.answer),
        judgementStatus: "failed",
        impact: "unknown",
        detail: "模型判断失败，未生成理解影响结论。",
        evidenceQuotes: [],
        score: null,
        confidence: 0,
    };
}

export function createAnalyzeExpressionTool(
    model: string,
): Tool<AnalyzeExpressionInput, ExpressionAnalysis> {
    return {
        name: "analyze_expression",
        description: "统计原回答中的口头语、相邻重复和长句，并判断其是否影响理解。",
        parameters: {
            type: "object",
            properties: {
                questionId: { type: "string", description: "面试问题 ID" },
                answer: { type: "string", description: "候选人的原始回答" },
            },
            required: ["questionId", "answer"],
            additionalProperties: false,
        },
        async execute(input, ctx) {
            const fallback = failedAnalysis(input);
            try {
                const judgement = await queryModelJson({
                    queryEngine: ctx.queryEngine,
                    model,
                    abortSignal: ctx.abortSignal,
                    schema: judgementSchema,
                    systemPrompt: [
                        "只基于输入中的候选人原回答，判断文本表达是否影响理解，严格输出 JSON。",
                        "不得改写、润色、补全或删除原回答；不确定时选择影响更低的结论。",
                        "每个 evidenceQuotes 项必须逐字来自原回答，且只引用支持结论的最短片段。",
                        "不得评价声音、语速、音量、语调、音质或其他音频表现。",
                    ].join("\n"),
                    userContent: JSON.stringify({ answer: input.answer }),
                });
                if (judgement.evidenceQuotes.some((quote) => !input.answer.includes(quote))) {
                    throw new Error("模型证据不在原回答中");
                }

                return {
                    success: true,
                    data: {
                        questionId: input.questionId,
                        stats: fallback.stats,
                        judgementStatus: "completed",
                        ...judgement,
                    },
                };
            } catch {
                return { success: true, data: fallback };
            }
        },
    };
}
