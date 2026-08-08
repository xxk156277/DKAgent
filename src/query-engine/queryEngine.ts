import type {
    AgentMessage,
    LLMProvider,
    StreamParams,
    ToolSchema,
} from "./provider.js";
import { parseStream, type ParsedResponse } from "./stream.js";

export interface QueryParams {
    model: string;
    messages: AgentMessage[];
    tools?: ToolSchema[];
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    abortSignal?: AbortSignal;
    onTextDelta?: (text: string) => void;
}

export class QueryEngine {
    constructor(private readonly provider: LLMProvider) { }

    async query(params: QueryParams): Promise<ParsedResponse> {
        const streamParams: StreamParams = {
            model: params.model,
            messages: params.messages,
            ...(params.tools !== undefined ? { tools: params.tools } : {}),
            ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
            ...(params.temperature !== undefined
                ? { temperature: params.temperature }
                : {}),
            ...(params.systemPrompt !== undefined
                ? { systemPrompt: params.systemPrompt }
                : {}),
            ...(params.abortSignal !== undefined
                ? { abortSignal: params.abortSignal }
                : {}),
        };

        return parseStream(
            this.provider.stream(streamParams),
            params.onTextDelta,
        );
    }
}
