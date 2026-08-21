import { z } from "zod";
import type { TraceSpan, Tracer } from "@dkagent/trace";
import type { QueryEngine } from "../query-engine/query-engine.js";

export async function queryModelJson<T>(input: {
    queryEngine: QueryEngine;
    model: string;
    systemPrompt: string;
    userContent: string;
    schema: z.ZodType<T>;
    abortSignal: AbortSignal;
    tracer?: Tracer | undefined;
    traceOperation: string;
}): Promise<T> {
    const request = {
        model: input.model,
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user" as const, content: input.userContent }],
        temperature: 0,
        responseFormat: "json_object" as const,
        thinking: "disabled" as const,
        abortSignal: input.abortSignal,
    };
    const traceRequest = {
        model: request.model,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        temperature: request.temperature,
        thinking: request.thinking,
    };
    const execute = async (span?: TraceSpan): Promise<T> => {
        const response = await input.queryEngine.query(request);
        span?.event("model.response", response);
        span?.setOutput(response);
        if (response.stopReason === "max_tokens") {
            throw new Error("结构化模型输出达到 Token 上限，JSON 可能被截断");
        }
        if (response.type !== "text") {
            throw new Error("结构化任务未返回文本");
        }

        const content = response.content
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "");
        return input.schema.parse(JSON.parse(content));
    };

    return input.tracer
        ? input.tracer.span(
            "model.request",
            traceRequest,
            execute,
            { module: "skill", operation: input.traceOperation },
        )
        : execute();
}
