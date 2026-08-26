import { z } from "zod";
import type { TraceSpan, Tracer } from "@dkagent/trace";
import type { ModelResponse } from "../query-engine/provider.js";
import type { QueryEngine } from "../query-engine/query-engine.js";

const SAFE_MODEL_REQUEST_ERROR = "结构化模型请求失败";
const SAFE_MODEL_OUTPUT_ERROR = "结构化模型输出无效";

function isAbortError(error: unknown): boolean {
    const value = error as { name?: unknown; code?: unknown } | null;
    return value?.name === "AbortError" || value?.code === "ABORT_ERR";
}

function createAbortError(): Error {
    const error = new Error("操作已中止");
    error.name = "AbortError";
    return error;
}

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
    if (input.abortSignal.aborted) throw createAbortError();

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
        systemPromptCharacterCount: input.systemPrompt.length,
        userContentCharacterCount: input.userContent.length,
        temperature: request.temperature,
        responseFormat: request.responseFormat,
        thinking: request.thinking,
    };
    const execute = async (span?: TraceSpan): Promise<ModelResponse> => {
        let response: ModelResponse;
        try {
            response = await input.queryEngine.query(request);
        } catch (error) {
            if (isAbortError(error) || input.abortSignal.aborted) {
                throw createAbortError();
            }
            throw new Error(SAFE_MODEL_REQUEST_ERROR);
        }
        const responseMetadata = {
            model: request.model,
            resultType: response.type,
            contentCharacterCount: response.content?.length ?? 0,
            usage: response.usage,
            stopReason: response.stopReason,
            ...(response.type === "tool_use" ? { toolCallCount: response.toolCalls.length } : {}),
        };
        span?.event("model.response", responseMetadata);
        span?.setOutput(responseMetadata);
        return response;
    };

    const response = input.tracer
        ? await input.tracer.span("model.request", traceRequest, execute, {
              module: "skill",
              operation: input.traceOperation,
          })
        : await execute();

    if (input.abortSignal.aborted) throw createAbortError();

    if (response.stopReason === "max_tokens") {
        throw new Error("结构化模型输出达到 Token 上限，JSON 可能被截断");
    }
    if (response.type !== "text") {
        throw new Error("结构化任务未返回文本");
    }

    const content = response.content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        return input.schema.parse(JSON.parse(content));
    } catch {
        throw new Error(SAFE_MODEL_OUTPUT_ERROR);
    }
}
