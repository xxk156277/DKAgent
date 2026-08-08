import { dispatchToolCall } from "./dispatcher.js";
import type { QueryEngine } from "../query-engine/queryEngine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { AgentMessage } from "../query-engine/provider.js";

interface TargetContent {
    content: string,
    path: string
}

export interface AgentRun {
    targetContent: TargetContent;
    messages: AgentMessage[];
    step: number;
    maxSteps: number;
    abortSignal: AbortSignal;
}

export interface RunAgentOptions {
    queryEngine: QueryEngine;
    toolRegistry: ToolRegistry;
    model: string;
    systemPrompt?: string;
    maxSteps?: number;
    abortSignal?: AbortSignal;
    onTextDelta?: (text: string) => void;
}

export async function runAgent(
    targetContent: TargetContent,
    options: RunAgentOptions,
): Promise<string> {
    const run: AgentRun = {
        targetContent,
        messages: [{
            role: 'user',
            content: `请帮我分析问文稿，路径:${targetContent.path}`
        }],
        step: 0,
        maxSteps: options.maxSteps ?? 4,
        abortSignal: options.abortSignal ?? new AbortController().signal,
    };
    while (run.step < run.maxSteps) {
        console.log(`------------第${run.step}轮--------------- \n`);

        if (run.abortSignal.aborted) {
            throw new Error("Agent Run 已中止");
        }

        run.step += 1;
        console.log(`\n[Agent] step=${run.step} model`);

        const response = await options.queryEngine.query({
            model: options.model,
            messages: run.messages,
            tools: options.toolRegistry.getSchemas(),
            temperature: 0,
            abortSignal: run.abortSignal,
            ...(options.systemPrompt !== undefined
                ? { systemPrompt: options.systemPrompt }
                : {}),
            ...(options.onTextDelta !== undefined
                ? { onTextDelta: options.onTextDelta }
                : {}),
        });

        if (response.type === "text") {
            const answer = response.content.trim();
            if (!answer) throw new Error("模型返回空文本");
            run.messages.push({
                role: "assistant",
                content: answer
            });
            return answer;
        }

        run.messages.push({
            role: "assistant",
            ...(response.content !== undefined ? { content: response.content } : {}),
            toolCalls: response.toolCalls,
        });

        for (const call of response.toolCalls) {
            console.log(`[Agent] tool=${call.name} id=${call.id}`);
            const dispatched = await dispatchToolCall(
                options.toolRegistry,
                call,
                {
                    queryEngine: options.queryEngine,
                    abortSignal: run.abortSignal,
                },
            );
            console.log(
                `[Agent] tool_result=${dispatched.result.success ? "success" : "failed"}`,
            );
            run.messages.push({
                role: "tool",
                toolCallId: dispatched.toolCallId,
                content: JSON.stringify(dispatched.result),
            });
        }
    }

    throw new Error(`Agent 超出最大循环次数：${run.maxSteps}`);
}
