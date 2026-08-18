import { createDiagnoseTranscriptSkill } from "../skills/diagnose-transcript.js";
import type { InterviewReferenceRetriever } from "../skills/interview-reference-retriever.js";
import { createFindFilesTool } from "./filesystem/find-files.js";
import { createGrepFilesTool } from "./filesystem/grep-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createWriteFileTool } from "./filesystem/write-file.js";
import { ToolRegistry } from "./registry.js";
import { createAnalyzeAnswerTool } from "./tool-item/analyze-answer.js";
import { createAnalyzeExpressionTool } from "./tool-item/analyze-expression.js";
import { createAnalyzeInterviewTool } from "./tool-item/analyze-interview.js";
import { createExtractProjectFactsTool } from "./tool-item/extract-project-facts.js";
import { createGenerateReportTool } from "./tool-item/generate-report.js";
import { createPreprocessTranscriptTool } from "./tool-item/preprocess-transcript.js";

export interface CreateToolRegistryOptions {
    cwd?: string;
    model: string;
    referenceRetriever?: InterviewReferenceRetriever;
    now?: () => Date;
}

export function createToolRegistry(options: CreateToolRegistryOptions): ToolRegistry {
    const cwd = options.cwd ?? process.cwd();
    const registry = new ToolRegistry();
    const readFileTool = createReadFileTool(cwd);
    const writeFileTool = createWriteFileTool(cwd);
    const skill = createDiagnoseTranscriptSkill({
        model: options.model,
        readFileTool,
        writeFileTool,
        preprocessTool: createPreprocessTranscriptTool(options.model),
        extractProjectFactsTool: createExtractProjectFactsTool(options.model),
        analyzeExpressionTool: createAnalyzeExpressionTool(options.model),
        analyzeAnswerTool: createAnalyzeAnswerTool(options.model),
        generateReportTool: createGenerateReportTool(options.model),
        ...(options.referenceRetriever ? { referenceRetriever: options.referenceRetriever } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    registry.register(readFileTool);
    registry.register(createFindFilesTool(cwd));
    registry.register(createGrepFilesTool(cwd));
    registry.register(writeFileTool);
    registry.register(createAnalyzeInterviewTool(skill, readFileTool));
    return registry;
}
