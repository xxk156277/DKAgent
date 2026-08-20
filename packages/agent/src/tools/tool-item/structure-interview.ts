import { structureInterview, type StructureOutput } from "../../interview/structurer.js";
import type { ParsedTranscript, TranscriptTurn } from "../../interview/types.js";
import type { Tool } from "../types.js";

export interface StructureInterviewInput {
    transcript: ParsedTranscript;
    correctedTurns: TranscriptTurn[];
}

export function createStructureInterviewTool(
    model: string,
): Tool<StructureInterviewInput, StructureOutput> {
    return {
        name: "structure_interview",
        description: "将纠错后的面试轮次组织为问题簇、具体问题和非问题轮次。",
        parameters: {
            type: "object",
            properties: {
                transcript: { type: "object", description: "parse_transcript 返回的原始面试稿" },
                correctedTurns: { type: "array", description: "preprocess_transcript 返回的纠错后轮次" },
            },
            required: ["transcript", "correctedTurns"],
            additionalProperties: false,
        },
        async execute(input, context) {
            try {
                return {
                    success: true,
                    data: await structureInterview({
                        transcript: input.transcript,
                        correctedTurns: input.correctedTurns,
                        queryEngine: context.queryEngine,
                        model,
                        abortSignal: context.abortSignal,
                        tracer: context.tracer,
                    }),
                };
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: error instanceof Error ? error.message : "面试问题结构化失败",
                    },
                };
            }
        },
    };
}
