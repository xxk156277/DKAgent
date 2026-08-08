export interface ToolCall {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export type AgentMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; content: string };

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface StreamParams {
    model: string;
    messages: AgentMessage[];
    tools?: ToolSchema[];
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    abortSignal?: AbortSignal;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

export type StreamEvent =
    | { type: "text_delta"; content: string }
    | { type: "tool_use_start"; id: string; name: string }
    | { type: "tool_use_delta"; input: string }
    | { type: "tool_use_end" }
    | { type: "message_end"; usage: TokenUsage; stopReason: StopReason };

export interface LLMProvider {
    readonly name: string;
    stream(params: StreamParams): AsyncIterable<StreamEvent>;
    countTokens(
        messages: AgentMessage[],
        tools?: ToolSchema[],
    ): Promise<number>;
}
