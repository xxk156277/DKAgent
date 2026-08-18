import { isAbsolute } from "node:path";
import type {
    DiagnoseTranscriptInput,
    DiagnoseTranscriptOutput,
} from "../../skills/diagnose-transcript.js";
import { readWholeText } from "../../skills/interview-file-io.js";
import type { ReadFileInput, ReadFileOutput } from "../filesystem/read-file.js";
import type { Tool } from "../types.js";

export interface AnalyzeInterviewInput extends DiagnoseTranscriptInput {
    jdPath?: string;
}

export function createAnalyzeInterviewTool(
    skill: { execute: Tool<AnalyzeInterviewInput, DiagnoseTranscriptOutput>["execute"] },
    readFileTool: Tool<ReadFileInput, ReadFileOutput>,
): Tool<AnalyzeInterviewInput, DiagnoseTranscriptOutput> {
    return {
        name: "analyze_interview",
        description: "对用户已确认的面试文字稿执行完整分析，并返回报告路径和摘要。",
        parameters: {
            type: "object",
            properties: {
                transcriptPath: { type: "string", description: "已确认的面试稿绝对路径" },
                metadata: { type: "object", description: "公司、岗位、日期和轮次" },
                jdText: { type: "string", description: "可选 JD 原文" },
                jdPath: { type: "string", description: "可选 JD 文件绝对路径" },
            },
            required: ["transcriptPath"],
            additionalProperties: false,
        },
        async execute(input, context) {
            if (!isAbsolute(input.transcriptPath)) {
                return { success: false, error: { code: "input_error", message: "面试稿必须使用绝对路径" } };
            }
            if (input.jdText && input.jdPath) {
                return { success: false, error: { code: "input_error", message: "jdText 与 jdPath 只能提供一个" } };
            }
            if (input.jdPath && !isAbsolute(input.jdPath)) {
                return { success: false, error: { code: "input_error", message: "JD 文件必须使用绝对路径" } };
            }
            try {
                const jdText = input.jdPath
                    ? (await readWholeText(readFileTool, input.jdPath, context)).content
                    : input.jdText;
                return skill.execute({
                    transcriptPath: input.transcriptPath,
                    ...(input.metadata ? { metadata: input.metadata } : {}),
                    ...(jdText?.trim() ? { jdText } : {}),
                }, context);
            } catch (error) {
                return {
                    success: false,
                    error: {
                        code: "service_error",
                        message: error instanceof Error ? error.message : "JD 读取失败",
                    },
                };
            }
        },
    };
}
