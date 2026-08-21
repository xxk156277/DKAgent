import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { queryModelJson } from "../../src/interview/model-json.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { FakeTextProvider } from "./fake-provider.js";

test("结构化模型请求开启 DeepSeek json_object", async () => {
    const provider = new FakeTextProvider('{"value":"ok"}');

    const result = await queryModelJson({
        queryEngine: new QueryEngine(provider),
        model: "deepseek-v4-pro",
        systemPrompt: "只输出 JSON。",
        userContent: "输入",
        schema: z.object({ value: z.string() }).strict(),
        abortSignal: new AbortController().signal,
        traceOperation: "test_json_output",
    });

    assert.deepEqual(result, { value: "ok" });
    assert.equal(provider.request?.responseFormat, "json_object");
    assert.equal(
        (provider.request as (typeof provider.request & { thinking?: string }))?.thinking,
        "disabled",
    );
});

test("结构化模型达到输出上限时返回清晰截断错误", async () => {
    const provider = new FakeTextProvider('{"value":"partial"}', "max_tokens");

    await assert.rejects(() => queryModelJson({
        queryEngine: new QueryEngine(provider),
        model: "deepseek-v4-pro",
        systemPrompt: "只输出 JSON。",
        userContent: "输入",
        schema: z.object({ value: z.string() }).strict(),
        abortSignal: new AbortController().signal,
        traceOperation: "test_json_output",
    }), /结构化模型输出达到 Token 上限，JSON 可能被截断/);
});
