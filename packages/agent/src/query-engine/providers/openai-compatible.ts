import OpenAI from "openai";
import type { AgentMessage, LLMProvider, ModelRequest, StopReason, StreamEvent, ToolSchema } from "../provider.js";

/** Stream 转换只依赖的 OpenAI Chunk 最小形状。 */
export interface OpenAIStreamChunk {
    choices: Array<{
        delta: {
            content?: string | null;
            tool_calls?: Array<{
                index: number;
                id?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason?: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details?: {
            cached_tokens?: number | null;
        } | null;
    } | null;
}

/** 把通用消息转换为 OpenAI Chat Completions 消息。 */
export function toOpenAIMessages(
    messages: readonly AgentMessage[],
    systemPrompt?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
        result.push({ role: "system", content: systemPrompt });
    }

    for (const message of messages) {
        if (message.role === "system" || message.role === "user") {
            result.push({ role: message.role, content: message.content });
            continue;
        }

        if (message.role === "assistant") {
            const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
                role: "assistant",
                content: message.content ?? null,
            };
            if (message.toolCalls?.length) {
                assistantMessage.tool_calls = message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input),
                    },
                }));
            }
            result.push(assistantMessage);
            continue;
        }

        result.push({
            role: "tool",
            tool_call_id: message.toolCallId,
            content: message.content,
        });
    }

    return result;
}

/** 把 Tool Registry Schema 转成 OpenAI Function Tool。 */
export function toOpenAITools(tools: readonly ToolSchema[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

/** 把 Provider 中立的输出格式转换为 OpenAI-Compatible response_format。 */
export function toOpenAIResponseFormat(format: ModelRequest["responseFormat"]): { type: "json_object" } | undefined {
    return format ? { type: format } : undefined;
}

/**
 * 把 OpenAI Chunk 转换成 Provider 中立事件。
 * Tool Call 在整个流结束后统一 End，保证每个 index 只闭合一次。
 */
export async function* translateOpenAIChunks(chunks: AsyncIterable<OpenAIStreamChunk>): AsyncIterable<StreamEvent> {
    const startedCalls = new Map<number, { id: string; name: string }>();
    let stopReason: StopReason = "unknown";
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of chunks) {
        if (chunk.usage) {
            const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined;
            usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                ...(cachedTokens === undefined ? {} : { cacheReadTokens: cachedTokens }),
            };
        }

        const choice = chunk.choices[0];
        if (!choice) {
            continue;
        }

        if (choice.delta.content) {
            yield { type: "text_delta", content: choice.delta.content };
        }

        for (const toolCall of choice.delta.tool_calls ?? []) {
            const existing = startedCalls.get(toolCall.index);
            if (!existing) {
                const id = toolCall.id;
                const name = toolCall.function?.name;
                if (!id || !name) {
                    throw new Error(`OpenAI Tool Call index ${toolCall.index} 首个 Chunk 缺少 ID 或名称`);
                }
                startedCalls.set(toolCall.index, { id, name });
                yield {
                    type: "tool_call_start",
                    index: toolCall.index,
                    id,
                    name,
                };
            } else {
                if (toolCall.id && toolCall.id !== existing.id) {
                    throw new Error(`OpenAI Tool Call index ${toolCall.index} 的 ID 发生变化`);
                }
                if (toolCall.function?.name && toolCall.function.name !== existing.name) {
                    throw new Error(`OpenAI Tool Call index ${toolCall.index} 的名称发生变化`);
                }
            }

            if (toolCall.function?.arguments) {
                yield {
                    type: "tool_call_delta",
                    index: toolCall.index,
                    argumentsDelta: toolCall.function.arguments,
                };
            }
        }

        if (choice.finish_reason) {
            stopReason = mapStopReason(choice.finish_reason);
        }
    }

    for (const index of [...startedCalls.keys()].sort((a, b) => a - b)) {
        yield { type: "tool_call_end", index };
    }

    yield { type: "message_end", usage, stopReason };
}

/** OpenAI-Compatible Chat Completions Provider。 */
export class OpenAICompatibleProvider implements LLMProvider {
    public readonly name = "openai-compatible";
    private readonly client: OpenAI;

    public constructor(apiKey: string, baseURL?: string) {
        this.client = new OpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
        });
    }

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        const responseFormat = toOpenAIResponseFormat(request.responseFormat);
        const thinking =
            request.thinking === "disabled" && supportsDeepSeekThinkingToggle(request.model)
                ? { type: "disabled" as const }
                : undefined;
        const openAIRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: request.model,
            messages: toOpenAIMessages(request.messages, request.systemPrompt),
            max_tokens: request.maxTokens ?? 20000,
            temperature: request.temperature ?? 0,
            stream: true,
            stream_options: { include_usage: true },
            parallel_tool_calls: false,
            ...(responseFormat ? { response_format: responseFormat } : {}),
            ...(thinking ? { thinking } : {}),
            ...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
            ...(request.abortSignal ? { signal: request.abortSignal } : {}),
        };

        const stream = await this.client.chat.completions.create(openAIRequest);

        yield* translateOpenAIChunks(stream);
    }

    /**
     * V1 使用本地近似估算；这不是官方 tokenizer 的精确结果。
     */
    public async countTokens(messages: AgentMessage[], tools?: ToolSchema[]): Promise<number> {
        const serialized = JSON.stringify({ messages, tools });
        return Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
    }
}

/** 仅对已验证支持 DeepSeek thinking 开关的模型发送厂商扩展字段。 */
function supportsDeepSeekThinkingToggle(model: string): boolean {
    return model.trim().toLowerCase() === "deepseek-v4-pro";
}

function mapStopReason(reason: string): StopReason {
    if (reason === "tool_calls" || reason === "function_call") {
        return "tool_use";
    }
    if (reason === "length") {
        return "max_tokens";
    }
    if (reason === "content_filter") {
        return "content_filter";
    }
    if (reason === "stop") {
        return "end_turn";
    }
    return "unknown";
}
