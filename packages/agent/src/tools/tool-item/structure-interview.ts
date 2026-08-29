import { structureInterview, type StructureOutput } from "../../interview/structurer.js";
import type { ParsedTranscript, StructuredInterview } from "../../interview/types.js";
import type { Tool } from "../types.js";

export interface StructureInterviewInput {
    transcriptArtifactId: string;
}

export interface StructureInterviewOutput {
    artifactId: string;
    clusterCount: number;
    questionIds: string[];
}

function isAbortError(error: unknown): boolean {
    const value = error as { name?: unknown; code?: unknown } | null;
    return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

function safeStructureFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    return message === "结构化模型输出达到 Token 上限，JSON 可能被截断"
        ? message
        : "面试问题结构化失败";
}

export function createStructureInterviewTool(
    model: string,
): Tool<StructureInterviewInput, StructureInterviewOutput> {
    return {
        name: "structure_interview",
        description: "将面试轮次组织为问题簇、具体问题和非问题轮次。",
        parameters: {
            type: "object",
            properties: {
                transcriptArtifactId: {
                    type: "string",
                    description: "parse_transcript 返回的 parsed_transcript Artifact ID",
                },
            },
            required: ["transcriptArtifactId"],
            additionalProperties: false,
        },
        async execute(input, context) {
            if (!input.transcriptArtifactId?.trim()) {
                return {
                    success: false,
                    error: { code: "input_error", message: "transcriptArtifactId 必填" },
                };
            }
            if (!context.artifactStore) {
                return {
                    success: false,
                    error: { code: "input_error", message: "ArtifactStore 未初始化" },
                };
            }

            let transcript: ParsedTranscript;
            try {
                transcript = context.artifactStore.get<ParsedTranscript>(
                    input.transcriptArtifactId,
                    "parsed_transcript",
                    "structure_interview",
                );
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "input_error",
                        message: error instanceof Error ? error.message : "面试文字稿 Artifact 读取失败",
                    },
                };
            }

            if (context.abortSignal.aborted) {
                return {
                    success: false,
                    error: { code: "timeout", message: "操作已中止" },
                };
            }

            try {
                const output: StructureOutput = await structureInterview({
                    transcript,
                    queryEngine: context.queryEngine,
                    model,
                    abortSignal: context.abortSignal,
                });
                const interview: StructuredInterview = { transcript, ...output };
                const artifactId = context.artifactStore.put(
                    "structured_interview",
                    interview,
                    {
                        producer: "structure_interview",
                        characterCount: JSON.stringify(interview).length,
                        itemCount: interview.questions.length,
                    },
                );
                return {
                    success: true,
                    data: {
                        artifactId,
                        clusterCount: interview.clusters.length,
                        questionIds: interview.questions.map((question) => question.id),
                    },
                };
            } catch (error) {
                if (isAbortError(error) || context.abortSignal.aborted) {
                    return {
                        success: false,
                        error: { code: "timeout", message: "操作已中止" },
                    };
                }
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: safeStructureFailureMessage(error),
                    },
                };
            }
        },
    };
}
