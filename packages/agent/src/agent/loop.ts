import { dispatchToolCall } from "./dispatcher.js";
import type { AgentLoopOptions } from "./types.js";
import type { AgentMessage } from "../query-engine/provider.js";
import type {
    ContextBuildInput,
    ConversationContextState,
} from "../context/types.js";
import { RuntimeEventPublisher } from "../runtime/events.js";


export class AgentLoop {
    private readonly messages: AgentMessage[] = [];
    /** 当前进程、当前会话的摘要状态；不会写入 messages。 */
    private contextState: ConversationContextState = {
        summary: "",
        firstKeptMessageIndex: 0,
        tokensBefore: 0,
        compactionCount: 0,
    };
    private readonly abortSignal: AbortSignal;
    private readonly runtimeEvents: RuntimeEventPublisher;

    constructor(private readonly options: AgentLoopOptions) {
        this.abortSignal = options.abortSignal ?? new AbortController().signal;
        this.runtimeEvents = new RuntimeEventPublisher(options.runtimeEventSink);
    }

    getMessages(): readonly AgentMessage[] {
        return [...this.messages];
    }

    /** 返回摘要状态副本，供调试和后续观测模块读取。 */
    getContextState(): Readonly<ConversationContextState> {
        return { ...this.contextState };
    }

    async run(userInput: string): Promise<string> {
        const turnId = this.runtimeEvents.createTurnId();
        this.runtimeEvents.emit("turn.start", turnId, { input: userInput });

        try {
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
                const contextBuildInput: ContextBuildInput = {
                    ...(this.options.systemPrompt === undefined
                        ? {}
                        : { systemPrompt: this.options.systemPrompt }),
                    messages: [...this.messages],
                    tools: this.options.toolRegistry.getSchemas(),
                    maxContextTokens: this.options.maxContextTokens,
                    reservedOutputTokens: this.options.maxOutputTokens,
                    ...(this.options.contextCompaction === undefined
                        ? {}
                        : {
                            compaction: {
                                state: { ...this.contextState },
                                options: this.options.contextCompaction,
                                summaryModel:
                                    this.options.summaryModel ??
                                    this.options.model,
                                abortSignal: this.abortSignal,
                            },
                        }),
                };

                this.runtimeEvents.emit(
                    "context.before",
                    turnId,
                    contextBuildInput,
                    step,
                );

                const contextSnapshot =
                    await this.options.contextManager.build(
                        contextBuildInput,
                    );

                // ContextManager 无状态，新的摘要边界由 AgentLoop 持有。
                if (contextSnapshot.nextContextState) {
                    this.contextState = {
                        ...contextSnapshot.nextContextState,
                    };
                }

                this.runtimeEvents.emit("context.after", turnId, contextSnapshot, step);

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
                this.runtimeEvents.emit("model.response", turnId, {
                    request: {
                        systemPrompt: contextSnapshot.systemPrompt,
                        messages: contextSnapshot.messages,
                        tools: contextSnapshot.tools,
                        maxTokens: this.options.maxOutputTokens,
                        temperature: 0,
                    },
                    response,
                }, step);

                console.log('\n -------返回的结果--------', response)

                if (response.type === "text") {
                    const answer = response.content.trim();
                    if (!answer) throw new Error("模型返回空文本");
                    this.messages.push({
                        role: "assistant",
                        content: answer
                    });
                    this.runtimeEvents.emit("turn.end", turnId, { answer }, step);
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
                    this.runtimeEvents.emit("tool.call", turnId, call, step);
                    const dispatched = await dispatchToolCall(
                        this.options.toolRegistry,
                        call,
                        {
                            queryEngine: this.options.queryEngine,
                            abortSignal: this.abortSignal,
                        },
                    );
                    this.runtimeEvents.emit("tool.result", turnId, dispatched, step);
                    this.messages.push({
                        role: "tool",
                        toolCallId: dispatched.toolCallId,
                        content: JSON.stringify(dispatched.result),
                    });
                }
            }

            throw new Error(`Agent 超出最大循环次数：${maxSteps}`);
        } catch (error: unknown) {
            this.runtimeEvents.emit("turn.error", turnId, {
                message: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
