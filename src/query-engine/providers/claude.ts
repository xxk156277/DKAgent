import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, StreamParams, StreamEvent } from '../provider.js';

export class ClaudeProvider implements LLMProvider {
    name = 'claude';
    private client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({ apiKey });
    }

    async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        const stream = this.client.messages.stream({
            model: params.model,
            max_tokens: params.maxTokens ?? 4096,
            temperature: params.temperature ?? 0,
            system: params.systemPrompt,
            messages: this.toAnthropicMessages(params.messages),
            tools: params.tools ? this.toAnthropicTools(params.tools) : undefined,
        });

        for await (const event of stream) {
            switch (event.type) {
                case 'content_block_start':
                    if (event.content_block.type === 'tool_use') {
                        yield {
                            type: 'tool_use_start',
                            id: event.content_block.id,
                            name: event.content_block.name,
                        };
                    }
                    break;

                case 'content_block_delta':
                    if (event.delta.type === 'text_delta') {
                        yield { type: 'text_delta', content: event.delta.text };
                    } else if (event.delta.type === 'input_json_delta') {
                        yield { type: 'tool_use_delta', input: event.delta.partial_json };
                    }
                    break;

                case 'content_block_stop':
                    // 判断是否是 tool_use block 结束
                    yield { type: 'tool_use_end' };
                    break;

                case 'message_stop':
                    const finalMessage = await stream.finalMessage();
                    yield {
                        type: 'message_end',
                        usage: {
                            inputTokens: finalMessage.usage.input_tokens,
                            outputTokens: finalMessage.usage.output_tokens,
                            cacheReadTokens: finalMessage.usage.cache_read_input_tokens,
                            cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens,
                        },
                        stopReason: finalMessage.stop_reason as StopReason,
                    };
                    break;
            }
        }
    }

    async countTokens(messages: Message[], tools?: ToolSchema[]): Promise<number> {
        const result = await this.client.messages.countTokens({
            model: 'claude-sonnet-4-20250514',
            messages: this.toAnthropicMessages(messages),
            tools: tools ? this.toAnthropicTools(tools) : undefined,
        });
        return result.input_tokens;
    }

    private toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
        // 转换通用 Message 格式到 Anthropic 格式
        // 处理 tool_result 消息的嵌套结构
    }

    private toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
        return tools.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
        }));
    }
}