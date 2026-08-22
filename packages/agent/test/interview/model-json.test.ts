import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
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

test("queryModelJson 的所有模型 Trace 只记录元数据", async () => {
    const secretPrompt = "秘密系统提示词";
    const secretInput = "秘密面试原文";
    const secretOutput = "秘密模型输出";
    const traceStore = new MemoryTraceStore();

    await queryModelJson({
        queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify({
            value: secretOutput,
        }))),
        model: "deepseek-v4-pro",
        systemPrompt: secretPrompt,
        userContent: secretInput,
        schema: z.object({ value: z.string() }).strict(),
        abortSignal: new AbortController().signal,
        tracer: new Tracer(traceStore),
        traceOperation: "test_json_trace",
    });

    const events = traceStore.list().filter((event) => (
        event.name === "model.request" || event.name === "model.response"
    ));
    assert.deepEqual(events.map((event) => [event.name, event.phase]), [
        ["model.request", "start"],
        ["model.response", "event"],
        ["model.request", "end"],
    ]);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, new RegExp(secretPrompt));
    assert.doesNotMatch(serialized, new RegExp(secretInput));
    assert.doesNotMatch(serialized, new RegExp(secretOutput));
    assert.doesNotMatch(serialized, /"systemPrompt":|"messages":|"content":/);
    assert.match(serialized, /systemPromptCharacterCount/);
    assert.match(serialized, /userContentCharacterCount/);
    assert.match(serialized, /inputTokens/);
    assert.match(serialized, /outputTokens/);
    assert.match(serialized, /stopReason/);
    assert.match(serialized, /resultType/);
});
