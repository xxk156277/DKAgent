import type {
    StopReason,
    StreamEvent,
    TokenUsage,
    ToolCall,
} from "./provider.js";

export type ParsedResponse =
    | {
        type: "text";
        content: string;
        usage: TokenUsage;
        stopReason: StopReason;
    }
    | {
        type: "tool_use";
        content?: string;
        toolCalls: ToolCall[];
        usage: TokenUsage;
        stopReason: StopReason;
    };

export async function parseStream(
    events: AsyncIterable<StreamEvent>,
    onTextDelta?: (text: string) => void,
): Promise<ParsedResponse> {
    let textContent = "";
    const toolCalls: ToolCall[] = [];
    let currentToolInput = "";
    let currentToolId = "";
    let currentToolName = "";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: StopReason = "end_turn";

    for await (const event of events) {
        switch (event.type) {
            case "text_delta":
                textContent += event.content;
                onTextDelta?.(event.content);
                break;
            case "tool_use_start":
                currentToolId = event.id;
                currentToolName = event.name;
                currentToolInput = "";
                break;
            case "tool_use_delta":
                currentToolInput += event.input;
                break;
            case "tool_use_end":
                toolCalls.push({
                    id: currentToolId,
                    name: currentToolName,
                    input: JSON.parse(currentToolInput) as Record<string, unknown>,
                });
                break;
            case "message_end":
                usage = event.usage;
                stopReason = event.stopReason;
                break;
        }
    }

    if (toolCalls.length > 0) {
        return {
            type: "tool_use",
            ...(textContent ? { content: textContent } : {}),
            toolCalls,
            usage,
            stopReason,
        };
    }

    return {
        type: "text",
        content: textContent,
        usage,
        stopReason
    };
}
