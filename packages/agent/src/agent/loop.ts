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
            const recalledMemory = await this.safeRecall(userInput);
            this.appendMessage({ role: "user", content: userInput });
            const maxSteps = this.options.maxSteps ?? 4;

            for (let step = 1; step <= maxSteps; step += 1) {
                const result = await this.tracer.span(
                    "agent.step",
                    { step },
                    (stepSpan) => this.runStep(step, stepSpan, recalledMemory),
                    { step },
                );
                if (result !== undefined) {
                    turnSpan.setOutput({ answer: result.answer });
                    if (result.shouldCaptureMemory) {
                        await this.safeCapture(userInput, result.answer);
                    }
                    return result.answer;
                }
            }

            throw new Error(`Agent 超出最大循环次数：${maxSteps}`);
        });
    }

    private async runStep(
        step: number,
        stepSpan: TraceSpan,
        recalledMemory: string,
    ): Promise<{ answer: string; shouldCaptureMemory: boolean } | undefined> {
        if (this.abortSignal.aborted) throw new Error("Agent Run 已中止");

        const systemPrompt = recalledMemory
            ? [this.options.systemPrompt, recalledMemory]
                .filter((value): value is string => Boolean(value))
                .join("\n\n")
            : this.options.systemPrompt;
        const contextBuildInput: ContextBuildInput = {
            ...(systemPrompt === undefined
                ? {}
                : { systemPrompt }),
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
        const traceRequest = recalledMemory
            ? {
                ...request,
                systemPrompt: this.createTraceSystemPrompt(
                    request.systemPrompt,
                    recalledMemory,
                ),
            }
            : { ...request };
        const response = await this.tracer.span(
            "model.request",
            traceRequest,
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
            return {
                answer,
                shouldCaptureMemory: response.stopReason === "end_turn",
            };
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

    /** Memory 不可用时仍按无记忆模式完成当前 Turn。 */
    private async safeRecall(userInput: string): Promise<string> {
        const reader = this.options.memoryReader;
        if (!reader) return "";

        try {
            return await this.tracer.span(
                "memory.recall",
                { userInputCharacterCount: userInput.length },
                async (span) => {
                    const recalledMemory = await reader.recall(userInput);
                    span.setOutput({ characterCount: recalledMemory.length });
                    return recalledMemory;
                },
                { module: "memory", operation: "recall" },
            );
        } catch {
            return "";
        }
    }

    /** 记忆只供模型使用；所有 Trace 必须使用不含原文的副本。 */
    private createTraceSystemPrompt(
        systemPrompt: string | undefined,
        recalledMemory: string,
    ): string | undefined {
        if (!recalledMemory) return systemPrompt;
        if (!systemPrompt?.includes(recalledMemory)) {
            return "[RECALLED_MEMORY_REDACTED]";
        }
        return systemPrompt
            .split(recalledMemory)
            .join("[RECALLED_MEMORY_REDACTED]");
    }

    /** 自动提取失败不能影响已生成的最终回答。 */
    private async safeCapture(userInput: string, answer: string): Promise<void> {
        const writer = this.options.memoryWriter;
        const sessionId = this.options.session?.snapshot.id;
        if (!writer || !sessionId) return;

        try {
            await this.tracer.span(
                "memory.write",
                {
                    sessionId,
                    userInputCharacterCount: userInput.length,
                    answerCharacterCount: answer.length,
                },
                async (span) => {
                    await writer.capture({
                        userInput,
                        assistantAnswer: answer,
                        sessionId,
                    });
                    span.setOutput({ captured: true });
                },
                { module: "memory", operation: "write" },
            );
        } catch {
            // Memory 是附加能力，写入失败不改变已经生成的回答。
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
