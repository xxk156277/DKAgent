import { z } from "zod";
import type { QueryEngine } from "../query-engine/query-engine.js";

export async function queryModelJson<T>(input: {
    queryEngine: QueryEngine;
    model: string;
    systemPrompt: string;
    userContent: string;
    schema: z.ZodType<T>;
    abortSignal: AbortSignal;
}): Promise<T> {
    const response = await input.queryEngine.query({
        model: input.model,
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: input.userContent }],
        temperature: 0,
        abortSignal: input.abortSignal,
    });
    if (response.type !== "text") {
        throw new Error("结构化任务未返回文本");
    }

    const content = response.content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
    return input.schema.parse(JSON.parse(content));
}
