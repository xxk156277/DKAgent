import type { InterviewReferenceRetriever } from "../skills/interview-reference-retriever.js";
import { createFindFilesTool } from "./filesystem/find-files.js";
import { createGrepFilesTool } from "./filesystem/grep-files.js";
import { createReadFileTool } from "./filesystem/read-file.js";
import { createWriteFileTool } from "./filesystem/write-file.js";
import { ToolRegistry } from "./registry.js";
import { createAnalyzeAnswerTool } from "./tool-item/analyze-answer.js";
<<<<<<< HEAD
import { createAnalyzeExpressionTool } from "./tool-item/analyze-expression.js";
import { createExtractProjectFactsTool } from "./tool-item/extract-project-facts.js";
import { createGenerateReportTool } from "./tool-item/generate-report.js";
import { createParseTranscriptTool } from "./tool-item/parse-transcript.js";
import { createPreprocessTranscriptTool } from "./tool-item/preprocess-transcript.js";
import { createSearchInterviewReferenceTool } from "./tool-item/search-interview-reference.js";
import { createStructureInterviewTool } from "./tool-item/structure-interview.js";
=======
import { createAnalyzeInterviewTool } from "./tool-item/analyze-interview.js";
import { createExtractProjectFactsTool } from "./tool-item/extract-project-facts.js";
import { createGenerateReportTool } from "./tool-item/generate-report.js";
>>>>>>> 3970f87 (refactor(agent): simplify interview analysis chain)

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
<<<<<<< HEAD
=======
    const skill = createDiagnoseTranscriptSkill({
        model: options.model,
        readFileTool,
        writeFileTool,
        extractProjectFactsTool: createExtractProjectFactsTool(options.model),
        analyzeAnswerTool: createAnalyzeAnswerTool(options.model),
        generateReportTool: createGenerateReportTool(options.model),
        ...(options.referenceRetriever ? { referenceRetriever: options.referenceRetriever } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
>>>>>>> 3970f87 (refactor(agent): simplify interview analysis chain)
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
