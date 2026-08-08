import type { Tool, ToolResult } from "../types.js";
import { readFile } from "node:fs/promises";


interface SplitQaOutput {
    pairs: QaPair[];
    totalQuestions: number;
    format: string;
}

interface SplitQaInput {
    transcriptPath: string;
    format?: "labeled" | "raw" | "auto";
}

export interface QaPair {
    index: number;
    question: string;
    answer: string;
    startOffset: number;
    endOffset: number;
}

export const splitQaTool: Tool<SplitQaInput, SplitQaOutput> = {
    name: "split_qa_pairs",
    description: "从带面试官/候选人或 Q/A 标签的面试文字稿中拆分问答对。",
    parameters: {
        type: "object",
        properties: {
            transcriptPath: {
                type: "string",
                description: "面试文字路径",
            },
            format: {
                type: "string",
                enum: ["labeled", "auto"],
                description: "labeled=有角色标签，auto=自动检测",
            },
        },
        required: ["transcriptPath"],
        additionalProperties: false,
    },
    execute: async (input): Promise<ToolResult<SplitQaOutput>> => {
        const { transcriptPath, format = "auto" } = input;

        const transcript = normalizeTranscript(await readFile(
            transcriptPath,
            "utf8"
        ));

        if (!transcript || transcript.length < 50) {
            return {
                success: false,
                error: {
                    code: "input_error",
                    message: "文字稿内容过短，无法拆分",
                },
            };
        }

        const detectedFormat = format === "auto"
            ? detectFormat(transcript)
            : format;

        if (detectedFormat !== "labeled") {
            return {
                success: false,
                error: {
                    code: "input_error",
                    message: "第一阶段仅支持带角色标签的面试稿",
                },
            };
        }

        const pairs = splitLabeled(transcript);
        if (pairs.length === 0) {
            return {
                success: false,
                error: {
                    code: "input_error",
                    message: "没有识别到完整的问答对",
                },
            };
        }

        return {
            success: true,
            data: {
                pairs,
                totalQuestions: pairs.length,
                format: detectedFormat,
            },
        };
    },
};

function normalizeTranscript(text: string): string {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[\u00a0\u2007\u202f]/g, " ")
        .split("\n")
        .map(normalizeSpeakerLine)
        .join("\n");
}

function normalizeSpeakerLine(line: string): string {
    const interviewerWithColon = line.match(
        /^\s*(?:面试官|Q|Interviewer|发言人\s*1)\s*[：:]\s*(.*)$/i,
    );
    if (interviewerWithColon) {
        return formatSpeakerLine("面试官", interviewerWithColon[1]);
    }

    if (/^\s*(?:面试官|Q|Interviewer|发言人\s*1)\s+\d{1,2}:\d{2}\s*$/i.test(line)) {
        return "面试官:";
    }

    const candidateWithColon = line.match(
        /^\s*(?:候选人|求职者|A|Candidate|发言人\s*2)\s*[：:]\s*(.*)$/i,
    );
    if (candidateWithColon) {
        return formatSpeakerLine("候选人", candidateWithColon[1]);
    }

    if (/^\s*(?:候选人|求职者|A|Candidate|发言人\s*2)\s+\d{1,2}:\d{2}\s*$/i.test(line)) {
        return "候选人:";
    }

    return line;
}

function formatSpeakerLine(
    speaker: "面试官" | "候选人",
    content: string | undefined,
): string {
    const trimmedContent = content?.trim() ?? "";
    return trimmedContent ? `${speaker}: ${trimmedContent}` : `${speaker}:`;
}

function detectFormat(text: string): "labeled" | "raw" {
    const questionPattern = /(?:面试官|Q|Interviewer|发言人1)[：:]/i;
    const answerPattern = /(?:候选人|A|Candidate|发言人2)[：:]/i;
    return questionPattern.test(text) && answerPattern.test(text)
        ? "labeled"
        : "raw";
}

function splitLabeled(text: string): QaPair[] {
    const segments = text.split(
        /(?=(?:面试官|候选人|Q|A|Interviewer|Candidate|发言人1|发言人2)[：:])/i,
    );
    const pairs: QaPair[] = [];
    let currentQuestion = "";
    let startOffset = 0;

    for (const segment of segments) {
        if (/^(?:面试官|Q|Interviewer|发言人1)[：:]/i.test(segment)) {
            currentQuestion = segment
                .replace(/^(?:面试官|Q|Interviewer|发言人1)[：:]\s*/i, "")
                .trim();
            startOffset = text.indexOf(segment);
            continue;
        }

        if (
            /^(?:候选人|A|Candidate|发言人2)[：:]/i.test(segment)
            && currentQuestion
        ) {
            const answer = segment
                .replace(/^(?:候选人|A|Candidate|发言人2)[：:]\s*/i, "")
                .trim();
            pairs.push({
                index: pairs.length + 1,
                question: currentQuestion,
                answer,
                startOffset,
                endOffset: text.indexOf(segment) + segment.length,
            });
            currentQuestion = "";
        }
    }

    return pairs;
}
