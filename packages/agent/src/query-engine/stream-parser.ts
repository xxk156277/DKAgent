import type {
    ModelResponse,
    StopReason,
    StreamEvent,
    TokenUsage,
    ToolCall,
} from "./provider.js";

interface ToolCallState {
    id: string;
    name: string;
    argumentsText: string;
    completed: boolean;
}

/** 流事件顺序或内容违反 QueryEngine 协议。 */
export class StreamProtocolError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "StreamProtocolError";
    }
}

/** Tool 参数无法安全解析成对象。 */
export class ToolInputParseError extends Error {
    public constructor(
        /** 原始 Tool Call ID。 */
        public readonly toolCallId: string,
        /** Tool 名称。 */
        public readonly toolName: string,
        /** 参数文本字符长度，不保存原文。 */
        public readonly argumentsLength: number,
        /** 模型停止原因，用于判断是否发生截断。 */
        public readonly stopReason: StopReason,
    ) {
        const reason = stopReason === "max_tokens"
            ? "Tool 参数可能因达到 Token 上限而截断"
            : "Tool 参数不是有效 JSON 对象";
        super(
            `${reason}：${toolName} (${toolCallId})，参数长度 ${argumentsLength}`,
        );
        this.name = "ToolInputParseError";
    }
}

/**
 * 将 Provider 中立流事件组装成一次完整模型响应。
 */
export async function parseModelStream(
    events: AsyncIterable<StreamEvent>,
    onTextDelta?: (text: string) => void,
): Promise<ModelResponse> {
    let textContent = "";
    let messageEnd:
        | { usage: TokenUsage; stopReason: StopReason }
        | undefined;
    const toolStates = new Map<number, ToolCallState>();

    for await (const event of events) {
        switch (event.type) {
            case "text_delta":
                textContent += event.content;
                onTextDelta?.(event.content);
                break;

            case "tool_call_start": {
                if (toolStates.has(event.index)) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 重复 Start`,
                    );
                }
                if (!event.id || !event.name) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 缺少 ID 或名称`,
                    );
                }
                toolStates.set(event.index, {
                    id: event.id,
                    name: event.name,
                    argumentsText: "",
                    completed: false,
                });
                break;
            }

            case "tool_call_delta": {
                const state = toolStates.get(event.index);
                if (!state) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 的 Delta 没有 Start`,
                    );
                }
                if (state.completed) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 已结束但仍收到 Delta`,
                    );
                }
                state.argumentsText += event.argumentsDelta;
                break;
            }

            case "tool_call_end": {
                const state = toolStates.get(event.index);
                if (!state) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 的 End 没有 Start`,
                    );
                }
                if (state.completed) {
                    throw new StreamProtocolError(
                        `Tool Call index ${event.index} 重复 End`,
                    );
                }
                state.completed = true;
                break;
            }

            case "message_end":
                if (messageEnd) {
                    throw new StreamProtocolError("Stream 出现重复 Message End");
                }
                messageEnd = {
                    usage: event.usage,
                    stopReason: event.stopReason,
                };
                break;
        }
    }

    if (!messageEnd) {
        throw new StreamProtocolError("Stream 缺少 Message End");
    }

    const toolCalls: ToolCall[] = [];
    for (const [index, state] of [...toolStates.entries()].sort(
        ([left], [right]) => left - right,
    )) {
        if (!state.completed) {
            throw new StreamProtocolError(
                `Tool Call index ${index} 缺少 End`,
            );
        }

        toolCalls.push({
            id: state.id,
            name: state.name,
            input: parseToolInput(state, messageEnd.stopReason),
        });
    }

    if (toolCalls.length > 0) {
        return {
            type: "tool_use",
            ...(textContent ? { content: textContent } : {}),
            toolCalls,
            usage: messageEnd.usage,
            stopReason: messageEnd.stopReason,
        };
    }

    return {
        type: "text",
        content: textContent,
        usage: messageEnd.usage,
        stopReason: messageEnd.stopReason,
    };
}

function parseToolInput(
    state: ToolCallState,
    stopReason: StopReason,
): Record<string, unknown> {
    try {
        const input = JSON.parse(state.argumentsText) as unknown;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new Error("Tool 参数必须是对象");
        }
        return input as Record<string, unknown>;
    } catch {
        throw new ToolInputParseError(
            state.id,
            state.name,
            state.argumentsText.length,
            stopReason,
        );
    }
}
