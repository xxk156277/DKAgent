import type { InterviewReferenceRetriever } from "../skills/interview-reference-retriever.js";
import { createFindFilesTool } from "./filesystem/find-files.js";
import { createGrepFilesTool } from "./filesystem/grep-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createWriteFileTool } from "./filesystem/write-file.js";
import { ToolRegistry } from "./registry.js";
import { createAnalyzeAnswerTool } from "./tool-item/analyze-answer.js";
import { createAnalyzeExpressionTool } from "./tool-item/analyze-expression.js";
import { createExtractProjectFactsTool } from "./tool-item/extract-project-facts.js";
import { createGenerateReportTool } from "./tool-item/generate-report.js";
import { createParseTranscriptTool } from "./tool-item/parse-transcript.js";
import { createPreprocessTranscriptTool } from "./tool-item/preprocess-transcript.js";
import { createSearchInterviewReferenceTool } from "./tool-item/search-interview-reference.js";
import { createStructureInterviewTool } from "./tool-item/structure-interview.js";

export interface CreateToolRegistryOptions {
    cwd?: string;
    model: string;
    referenceRetriever?: InterviewReferenceRetriever;
}

export function createToolRegistry(options: CreateToolRegistryOptions): ToolRegistry {
    const cwd = options.cwd ?? process.cwd();
    const registry = new ToolRegistry();
    const readFileTool = createReadFileTool(cwd);
    const writeFileTool = createWriteFileTool(cwd);
    registry.register(readFileTool);
    registry.register(createFindFilesTool(cwd));
    registry.register(createGrepFilesTool(cwd));
    registry.register(writeFileTool);
    registry.register(createParseTranscriptTool());
    registry.register(createPreprocessTranscriptTool(options.model));
    registry.register(createStructureInterviewTool(options.model));
    registry.register(createExtractProjectFactsTool(options.model));
    registry.register(createAnalyzeExpressionTool(options.model));
    if (options.referenceRetriever) {
        registry.register(createSearchInterviewReferenceTool(options.referenceRetriever));
    }
    registry.register(createAnalyzeAnswerTool(options.model));
    registry.register(createGenerateReportTool(options.model));
    return registry;
}
