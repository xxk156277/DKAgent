import { parseTranscript } from "../../interview/transcript-parser.js";
import type { Tool } from "../types.js";

export interface ParseTranscriptInput {
    sourceArtifactId: string;
}

export interface ParseTranscriptOutput {
    artifactId: string;
    turnCount: number;
}

export function createParseTranscriptTool(): Tool<ParseTranscriptInput, ParseTranscriptOutput> {
    return {
        name: "parse_transcript",
        description: "将完整面试文字稿按说话人标题解析为可追溯的原始轮次。",
        parameters: {
            type: "object",
            properties: {
                sourceArtifactId: { type: "string", description: "read_file 返回的 file_text Artifact ID" },
            },
            required: ["sourceArtifactId"],
            additionalProperties: false,
        },
        async execute(input, context) {
            if (!input.sourceArtifactId?.trim()) {
                return {
                    success: false,
                    error: { code: "input_error", message: "sourceArtifactId 必填" },
                };
            }
            if (!context.artifactStore) {
                return {
                    success: false,
                    error: { code: "input_error", message: "ArtifactStore 未初始化" },
                };
            }
            try {
                const source = context.artifactStore.get<string>(
                    input.sourceArtifactId,
                    "file_text",
                    "parse_transcript",
                );
                const transcript = parseTranscript(source);
                const artifactId = context.artifactStore.put("parsed_transcript", transcript, {
                    producer: "parse_transcript",
                    characterCount: source.length,
                    itemCount: transcript.turns.length,
                });
                return {
                    success: true,
                    data: { artifactId, turnCount: transcript.turns.length },
                };
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
