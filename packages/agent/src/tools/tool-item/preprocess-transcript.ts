import { z } from "zod";
import { queryModelJson } from "../../interview/model-json.js";
import type {
    ParsedTranscript,
    TranscriptCorrection,
} from "../../interview/types.js";
import type { Tool } from "../types.js";

const correctionSchema = z.object({
    corrections: z.array(z.object({
        turnId: z.string().min(1),
        original: z.string().min(1),
        replacement: z.string().min(1),
        confidence: z.number().min(0).max(1),
        reason: z.string().min(1),
    }).strict()),
}).strict();

const PROTECTED_FILLERS = ["嗯", "呃", "额", "然后", "就是", "那个"] as const;

interface PreprocessTranscriptInput {
    transcript: ParsedTranscript;
}

interface PreprocessTranscriptOutput {
    corrections: TranscriptCorrection[];
    correctedTurns: ParsedTranscript["turns"];
}

function countOccurrences(text: string, token: string): number {
    let count = 0;
    let fromIndex = 0;
    while (fromIndex < text.length) {
        const index = text.indexOf(token, fromIndex);
        if (index < 0) break;
        count += 1;
        fromIndex = index + token.length;
    }
    return count;
}

function removesProtectedExpression(original: string, replacement: string): boolean {
    if (PROTECTED_FILLERS.some((token) => (
        countOccurrences(replacement, token) < countOccurrences(original, token)
    ))) {
        return true;
    }

    for (let size = 1; size <= Math.min(6, Math.floor(original.length / 2)); size += 1) {
        for (let index = 0; index + size * 2 <= original.length; index += 1) {
            const repeated = original.slice(index, index + size);
            if (
                repeated === original.slice(index + size, index + size * 2)
                && !replacement.includes(repeated + repeated)
            ) {
                return true;
            }
        }
    }

    return false;
}

export function createPreprocessTranscriptTool(
    model: string,
): Tool<PreprocessTranscriptInput, PreprocessTranscriptOutput> {
    return {
        name: "preprocess_transcript",
        description: "识别高置信转写错误并返回可追溯 Diff，不清理表达口头语。",
        parameters: {
            type: "object",
            properties: {
                transcript: { type: "object", description: "已解析的原始面试稿" },
            },
            required: ["transcript"],
            additionalProperties: false,
        },
        async execute(input, ctx) {
            try {
                const response = await queryModelJson({
                    queryEngine: ctx.queryEngine,
                    model,
                    abortSignal: ctx.abortSignal,
                    schema: correctionSchema,
                    systemPrompt: [
                        "你只识别明显的转写错误，严格输出 JSON。",
                        "不得润色、补全，不得删除或修复口头语、停顿、重复和卡壳。",
                        "不确定时不要输出纠错。",
                    ].join("\n"),
                    userContent: JSON.stringify(input.transcript.turns.map((turn) => ({
                        id: turn.id,
                        speaker: turn.speaker,
                        content: turn.content,
                    }))),
                });
                const turnById = new Map(
                    input.transcript.turns.map((turn) => [turn.id, turn]),
                );
                const corrections = response.corrections.filter((item) => {
                    const turn = turnById.get(item.turnId);
                    return item.confidence >= 0.95
                        && item.original !== item.replacement
                        && Boolean(turn?.content.includes(item.original))
                        && !removesProtectedExpression(item.original, item.replacement);
                });
                const correctedTurns = input.transcript.turns.map((turn) => ({
                    ...turn,
                    content: corrections
                        .filter((item) => item.turnId === turn.id)
                        .reduce(
                            (content, item) => content.replace(item.original, item.replacement),
                            turn.content,
                        ),
                }));

                return { success: true, data: { corrections, correctedTurns } };
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: error instanceof Error ? error.message : "纠错失败",
                    },
                };
            }
        },
    };
}
