import OpenAI from "openai";
import type {
    AgentMessage,
    LLMProvider,
    StopReason,
    StreamEvent,
    StreamParams,
    ToolSchema,
} from "../provider.js";

export function toOpenAIMessages(
    messages: AgentMessage[],
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

            if (message.toolCalls) {
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
    console.log('messages', result)

    return result;
}

export function toOpenAITools(
    tools: ToolSchema[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

export class OpenAIProvider implements LLMProvider {
    readonly name = "openai";
    private readonly client: OpenAI;

    constructor(apiKey: string, baseURL?: string) {
        this.client = new OpenAI({
            apiKey,
            ...(baseURL ? { baseURL } : {}),
        });
    }

    async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
            model: params.model,
            messages: toOpenAIMessages(params.messages, params.systemPrompt),
            max_tokens: params.maxTokens ?? 4096,
            temperature: params.temperature ?? 0,
            parallel_tool_calls: false,
            stream: true,
            ...(params.tools && params.tools.length > 0
                ? { tools: toOpenAITools(params.tools) }
                : {}),
        };



        const stream = params.abortSignal
            ? await this.client.chat.completions.create(request, {
                signal: params.abortSignal,
            })
            : await this.client.chat.completions.create(request);

        let currentToolCallId = "";
        let currentToolName = "";

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            const delta = choice?.delta;

            if (delta?.content) {
                yield { type: "text_delta", content: delta.content };
            }

            for (const toolCall of delta?.tool_calls ?? []) {
                if (toolCall.id) {
                    currentToolCallId = toolCall.id;
                    currentToolName = toolCall.function?.name ?? "";
                    yield {
                        type: "tool_use_start",
                        id: currentToolCallId,
                        name: currentToolName,
                    };
                }

                if (toolCall.function?.arguments) {
                    yield {
                        type: "tool_use_delta",
                        input: toolCall.function.arguments,
                    };
                }
            }

            if (choice?.finish_reason) {
                if (currentToolCallId) {
                    yield { type: "tool_use_end" };
                }

                yield {
                    type: "message_end",
                    usage: { inputTokens: 0, outputTokens: 0 },
                    stopReason: mapStopReason(choice.finish_reason),
                };
            }
        }
    }

    async countTokens(
        messages: AgentMessage[],
        tools?: ToolSchema[],
    ): Promise<number> {
        return Math.ceil(JSON.stringify({ messages, tools }).length / 4);
    }
}

function mapStopReason(reason: string): StopReason {
    if (reason === "tool_calls") return "tool_use";
    if (reason === "length") return "max_tokens";
    return "end_turn";
}
