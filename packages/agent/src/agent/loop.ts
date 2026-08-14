import { Tracer, type TraceSpan } from "@dkagent/trace";
import { dispatchToolCall } from "./dispatcher.js";
import type { AgentLoopOptions } from "./types.js";
import type { AgentMessage, ModelResponse } from "../query-engine/provider.js";
import type {
    ContextBuildInput,
    ConversationContextState,
} from "../context/types.js";

export class AgentLoop {
    private readonly messages: AgentMessage[];
    /** Agent 只保存下一次压缩决策真正需要的状态。 */
    private contextState: ConversationContextState;
    private readonly abortSignal: AbortSignal;
    private readonly tracer: Tracer;

    public constructor(private readonly options: AgentLoopOptions) {
        this.messages = options.session
            ? [...options.session.snapshot.messages]
            : [];
        this.contextState = options.session
            ? { ...options.session.snapshot.contextState }
            : {
                summary: "",
                firstKeptMessageIndex: 0,
            };
        this.abortSignal = options.abortSignal ?? new AbortController().signal;
        this.tracer = options.tracer ?? new Tracer();
    }

    public getMessages(): readonly AgentMessage[] {
        return [...this.messages];
    }

    /** 返回运行状态副本，不包含任何 Tap 展示统计。 */
    public getContextState(): Readonly<ConversationContextState> {
        return { ...this.contextState };
    }

    public run(userInput: string): Promise<string> {
        return this.tracer.trace("agent.turn", { input: userInput }, async (turnSpan) => {
            this.appendMessage({ role: "user", content: userInput });
            const maxSteps = this.options.maxSteps ?? 4;

            for (let step = 1; step <= maxSteps; step += 1) {
                const answer = await this.tracer.span(
                    "agent.step",
                    { step },
                    (stepSpan) => this.runStep(step, stepSpan),
                    { step },
                );
                if (answer !== undefined) {
                    turnSpan.setOutput({ answer });
                    return answer;
                }
            }

            throw new Error(`Agent 超出最大循环次数：${maxSteps}`);
        });
    }

    private async runStep(step: number, stepSpan: TraceSpan): Promise<string | undefined> {
        if (this.abortSignal.aborted) throw new Error("Agent Run 已中止");

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
                        summaryModel: this.options.summaryModel ?? this.options.model,
                        abortSignal: this.abortSignal,
                    },
                }),
        };
        const contextSnapshot = await this.options.contextManager.build(contextBuildInput);
        if (contextSnapshot.nextContextState) {
            const nextState = { ...contextSnapshot.nextContextState };
            const session = this.options.session;
            if (session) {
                session.store.saveContextState(
                    session.snapshot.id,
                    nextState,
                );
            }
            this.contextState = nextState;
        }

        const request = {
            model: this.options.model,
            messages: contextSnapshot.messages,
            tools: contextSnapshot.tools,
            maxTokens: this.options.maxOutputTokens,
            temperature: 0,
            abortSignal: this.abortSignal,
            ...(contextSnapshot.systemPrompt === undefined
                ? {}
                : { systemPrompt: contextSnapshot.systemPrompt }),
            ...(this.options.onTextDelta === undefined
                ? {}
                : { onTextDelta: this.options.onTextDelta }),
        };
        const response = await this.tracer.span(
            "model.request",
            request,
            async (modelSpan) => {
                const result = await this.options.queryEngine.query(request);
                modelSpan.event("model.response", result, { step });
                modelSpan.setOutput(result);
                return result;
            },
            { step },
        );

        if (response.type === "text") {
            const answer = response.content.trim();
            if (!answer) throw new Error("模型返回空文本");
            this.appendMessage({ role: "assistant", content: answer });
            stepSpan.setOutput({ answer });
            return answer;
        }

        this.appendMessage({
            role: "assistant",
            ...(response.content === undefined ? {} : { content: response.content }),
            toolCalls: response.toolCalls,
        });
        await this.runToolCalls(response, step);
        stepSpan.setOutput({ toolCallCount: response.toolCalls.length });
        return undefined;
    }

    private async runToolCalls(
        response: Extract<ModelResponse, { type: "tool_use" }>,
        step: number,
    ): Promise<void> {
        for (const call of response.toolCalls) {
            const dispatched = await this.tracer.span(
                "tool.call",
                call,
                async (toolSpan) => {
                    const result = await dispatchToolCall(
                        this.options.toolRegistry,
                        call,
                        {
                            queryEngine: this.options.queryEngine,
                            abortSignal: this.abortSignal,
                        },
                    );
                    toolSpan.event("tool.result", result, { step });
                    toolSpan.setOutput(result);
                    return result;
                },
                { step },
            );
            this.appendMessage({
                role: "tool",
                toolCallId: dispatched.toolCallId,
                content: JSON.stringify(dispatched.result),
            });
        }
    }

    /** 先持久化消息，再更新 AgentLoop 内存历史。 */
    private appendMessage(message: AgentMessage): void {
        const session = this.options.session;
        if (session) {
            session.store.appendMessage(session.snapshot.id, message);
        }
        this.messages.push(message);
    }
}
