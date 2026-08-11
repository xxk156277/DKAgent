import { dispatchToolCall } from "./dispatcher.js";
import type { AgentLoopOptions } from "./types.js";
import type { AgentMessage } from "../query-engine/provider.js";


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

            /**
             * 在调用模型前，组织Context，生成快照
             *
             * this.messages 是完整会话历史。
             * ContextManager 只基于它生成本次请求快照，
             * 不会删除或修改完整历史。
             */
            const contextSnapshot =
                await this.options.contextManager.build({
                    ...(this.options.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: this.options.systemPrompt }),
                    messages: this.messages,
                    tools: this.options.toolRegistry.getSchemas(),
                    maxContextTokens: this.options.maxContextTokens,
                    // 输出上限同时也是上下文需要预留的空间。
                    reservedOutputTokens: this.options.maxOutputTokens,
                });

            /**
             * 根据 context 快照，生成模型调用入参
             */
            const queryParams = {
                model: this.options.model,
                messages: contextSnapshot.messages,
                tools: contextSnapshot.tools,
                maxTokens:
                    this.options.maxOutputTokens,
                temperature: 0,
                abortSignal: this.abortSignal,
                ...(contextSnapshot.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: contextSnapshot.systemPrompt }),

                ...(this.options.onTextDelta === undefined
                    ? {}
                    : { onTextDelta: this.options.onTextDelta }),
            }

            /**
             * 调用模型
             */
            const response = await this.options.queryEngine.query(queryParams);

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
