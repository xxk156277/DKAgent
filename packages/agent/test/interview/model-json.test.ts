import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { z } from "zod";
import { queryModelJson } from "../../src/interview/model-json.js";
import type { LLMProvider } from "../../src/query-engine/provider.js";
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

test("Provider 异常对调用方和 Trace 都使用固定安全错误", async () => {
    const secret = "Provider 异常中的秘密面试原文";
    const original = new Error(secret);
    const provider = {
        name: "throwing",
        async *stream() {
            throw original;
        },
        async countTokens() {
            return 0;
        },
    } satisfies LLMProvider;
    const traceStore = new MemoryTraceStore();

    await assert.rejects(
        () => queryModelJson({
            queryEngine: new QueryEngine(provider),
            model: "deepseek-v4-pro",
            systemPrompt: "只输出 JSON。",
            userContent: "输入",
            schema: z.object({ value: z.string() }).strict(),
            abortSignal: new AbortController().signal,
            tracer: new Tracer(traceStore),
            traceOperation: "test_provider_error",
        }),
        (error: unknown) => {
            assert.equal((error as Error).message, "结构化模型请求失败");
            return true;
        },
    );

    const events = traceStore.list().filter((event) => event.name === "model.request");
    assert.deepEqual(events.map((event) => event.phase), ["start", "error"]);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.match(serialized, /结构化模型请求失败/);
});

test("JSON 解析和 Zod Schema 失败只抛固定输出错误", async () => {
    const secret = "MODEL_OUTPUT_SECRET_20260822";
    for (const response of [
        `${secret} not-json`,
        JSON.stringify({ value: "ok", [secret]: true }),
    ]) {
        await assert.rejects(
            () => queryModelJson({
                queryEngine: new QueryEngine(new FakeTextProvider(response)),
                model: "deepseek-v4-pro",
                systemPrompt: "只输出 JSON。",
                userContent: "输入",
                schema: z.object({ value: z.string() }).strict(),
                abortSignal: new AbortController().signal,
                traceOperation: "test_invalid_output",
            }),
            (error: unknown) => {
                assert.equal((error as Error).message, "结构化模型输出无效");
                assert.doesNotMatch((error as Error).message, new RegExp(secret));
                return true;
            },
        );
    }
});

test("AbortError、ABORT_ERR 和已中止 Signal 保持安全取消语义", async () => {
    const secret = "ABORT_SECRET_20260822";
    const cases = [
        Object.assign(new Error(secret), { name: "AbortError" }),
        Object.assign(new Error(secret), { code: "ABORT_ERR" }),
    ];

    for (const original of cases) {
        const provider = {
            name: "aborting",
            async *stream() {
                throw original;
            },
            async countTokens() {
                return 0;
            },
        } satisfies LLMProvider;
        const traceStore = new MemoryTraceStore();
        await assert.rejects(
            () => queryModelJson({
                queryEngine: new QueryEngine(provider),
                model: "deepseek-v4-pro",
                systemPrompt: "只输出 JSON。",
                userContent: "输入",
                schema: z.object({ value: z.string() }).strict(),
                abortSignal: new AbortController().signal,
                tracer: new Tracer(traceStore),
                traceOperation: "test_abort",
            }),
            (error: unknown) => {
                assert.equal((error as Error).name, "AbortError");
                assert.equal((error as Error).message, "操作已中止");
                return true;
            },
        );
        assert.doesNotMatch(JSON.stringify(traceStore.list()), new RegExp(secret));
    }

    let providerCalled = false;
    const controller = new AbortController();
    controller.abort(secret);
    const provider = {
        name: "must-not-run",
        async *stream() {
            providerCalled = true;
            yield { type: "text_delta" as const, content: "{}" };
        },
        async countTokens() {
            return 0;
        },
    } satisfies LLMProvider;
    await assert.rejects(
        () => queryModelJson({
            queryEngine: new QueryEngine(provider),
            model: "deepseek-v4-pro",
            systemPrompt: "只输出 JSON。",
            userContent: "输入",
            schema: z.object({ value: z.string() }).strict(),
            abortSignal: controller.signal,
            traceOperation: "test_pre_aborted",
        }),
        (error: unknown) => (error as Error).name === "AbortError",
    );
    assert.equal(providerCalled, false);
});
