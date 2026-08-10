import { dispatchToolCall } from "./dispatcher.js";
import type { QueryEngine } from "../query-engine/queryEngine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentMessage } from "../query-engine/provider.js";

export interface AgentLoopOptions {
    queryEngine: QueryEngine;
    toolRegistry: ToolRegistry;
    model: string;
    systemPrompt?: string;
    maxSteps?: number;
    abortSignal?: AbortSignal;
    onTextDelta?: (text: string) => void;
}

export class AgentLoop {
    private readonly messages: AgentMessage[] = [];
    private readonly abortSignal: AbortSignal;

    constructor(private readonly options: AgentLoopOptions) {
        this.abortSignal = options.abortSignal ?? new AbortController().signal;
    }

    getMessages(): readonly AgentMessage[] {
        return [...this.messages];
    }

    async run(userInput: string): Promise<string> {


        this.messages.push({
            role: "user",
            content: userInput
        });

        const maxSteps = this.options.maxSteps ?? 4;
        for (let step = 1; step <= maxSteps; step += 1) {
            if (this.abortSignal.aborted) {
                throw new Error("Agent Run 已中止");
            }

            const response = await this.options.queryEngine.query({
                model: this.options.model,
                // 每次模型请求使用消息快照，避免后续追加内容污染本次请求。
                messages: [...this.messages],
                tools: this.options.toolRegistry.getSchemas(),
                temperature: 0,
                abortSignal: this.abortSignal,
                ...(this.options.systemPrompt !== undefined
                    ? { systemPrompt: this.options.systemPrompt }
                    : {}),
                ...(this.options.onTextDelta !== undefined
                    ? { onTextDelta: this.options.onTextDelta }
                    : {}),
            });

            console.log('\n -------返回的结果--------', response)

            if (response.type === "text") {
                const answer = response.content.trim();
                if (!answer) throw new Error("模型返回空文本");
                this.messages.push({
                    role: "assistant",
                    content: answer
                });
                return answer;
            }

            this.messages.push({
                role: "assistant",
                ...(response.content !== undefined
                    ? { content: response.content }
                    : {}),
                toolCalls: response.toolCalls,
            });

            for (const call of response.toolCalls) {
                const dispatched = await dispatchToolCall(
                    this.options.toolRegistry,
                    call,
                    {
                        queryEngine: this.options.queryEngine,
                        abortSignal: this.abortSignal,
                    },
                );
                this.messages.push({
                    role: "tool",
                    toolCallId: dispatched.toolCallId,
                    content: JSON.stringify(dispatched.result),
                });
            }
        }

        throw new Error(`Agent 超出最大循环次数：${maxSteps}`);
    }
}
