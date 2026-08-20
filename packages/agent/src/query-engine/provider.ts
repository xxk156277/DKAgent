/** 模型请求中使用的一次 Tool Call。 */
export interface ToolCall {
    /** Provider 返回的原始调用 ID，Tool Result 必须原样引用。 */
    id: string;
    /** 要调用的 Tool 名称。 */
    name: string;
    /** 已解析的 Tool 参数对象。 */
    input: Record<string, unknown>;
}

/** Agent 与模型之间共享的消息协议。 */
export type AgentMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
    | { role: "tool"; toolCallId: string; content: string };

/** 发送给模型的 Tool Function Schema。 */
export interface ToolSchema {
    /** Tool 唯一名称。 */
    name: string;
    /** 帮助模型判断使用时机的描述。 */
    description: string;
    /** JSON Schema 格式的参数定义。 */
    parameters: Record<string, unknown>;
}

/** 一次完整模型请求。 */
export interface ModelRequest {
    /** 模型 ID。 */
    model: string;
    /** 本次请求使用的消息快照。 */
    messages: AgentMessage[];
    /** 当前允许模型调用的 Tool。 */
    tools?: ToolSchema[];
    /** 模型最大输出 Token 数。 */
    maxTokens?: number;
    /** 采样温度。 */
    temperature?: number;
    /** 输出格式；省略表示普通文本，json_object 表示要求 Provider 返回合法 JSON。 */
    responseFormat?: "json_object";
    /** 独立于普通消息的系统提示词。 */
    systemPrompt?: string;
    /** 用于中止 Provider 请求。 */
    abortSignal?: AbortSignal;
    /** 每收到一段文本时触发的回调。 */
    onTextDelta?: (text: string) => void;
}

/** Provider 返回的 Token 使用量。 */
export interface TokenUsage {
    /** 输入 Token 数。 */
    inputTokens: number;
    /** 输出 Token 数。 */
    outputTokens: number;
    /** 命中缓存的输入 Token 数。 */
    cacheReadTokens?: number;
    /** 写入缓存的输入 Token 数。 */
    cacheWriteTokens?: number;
}

/** 模型停止生成的统一原因。 */
export type StopReason =
    | "end_turn"
    | "tool_use"
    | "max_tokens"
    | "content_filter"
    | "unknown";

/** Provider 中立的流事件协议。 */
export type StreamEvent =
    | { type: "text_delta"; content: string }
    | { type: "tool_call_start"; index: number; id: string; name: string }
    | { type: "tool_call_delta"; index: number; argumentsDelta: string }
    | { type: "tool_call_end"; index: number }
    | { type: "message_end"; usage: TokenUsage; stopReason: StopReason };

/** 一次模型调用的最终结果。 */
export type ModelResponse =
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

/** 模型厂商适配器必须实现的最小能力。 */
export interface LLMProvider {
    /** Provider 名称，用于日志和后续评估。 */
    readonly name: string;
    /** 把一次请求转换成 Provider 中立流事件。 */
    stream(request: ModelRequest): AsyncIterable<StreamEvent>;
    /** 估算消息和 Tool Schema 占用的输入 Token。 */
    countTokens(
        messages: AgentMessage[],
        tools?: ToolSchema[],
    ): Promise<number>;
}

/** 旧名称兼容别名，迁移完成后调用方统一使用 ModelRequest。 */
export type StreamParams = ModelRequest;
