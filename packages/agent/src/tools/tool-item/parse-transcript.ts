import { parseTranscript } from "../../interview/transcript-parser.js";
import type { ParsedTranscript } from "../../interview/types.js";
import type { Tool } from "../types.js";

export interface ParseTranscriptInput {
    content: string;
}

export function createParseTranscriptTool(): Tool<ParseTranscriptInput, ParsedTranscript> {
    return {
        name: "parse_transcript",
        description: "将完整面试文字稿按说话人标题解析为可追溯的原始轮次。",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "完整面试文字稿原文" },
            },
            required: ["content"],
            additionalProperties: false,
        },
        async execute(input) {
            if (!input.content?.trim()) {
                return {
                    success: false,
                    error: { code: "input_error", message: "面试文字稿不能为空" },
                };
            }
            try {
                return { success: true, data: parseTranscript(input.content) };
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "input_error",
                        message: error instanceof Error ? error.message : "面试文字稿解析失败",
                    },
                };
            }
        },
    };
}
