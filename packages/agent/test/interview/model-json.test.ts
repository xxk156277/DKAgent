import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { z } from "zod";
import { queryModelJson } from "../../src/interview/model-json.js";
import type { LLMProvider, StreamEvent } from "../../src/query-engine/provider.js";
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
    }), /结构化模型输出达到 Token 上限，JSON 可能被截断/);
});

test("queryModelJson 由 QueryEngine 记录完整 model.generate Trace", async () => {
    const secretPrompt = "秘密系统提示词";
    const secretInput = "秘密面试原文";
    const secretOutput = "秘密模型输出";
    const traceStore = new MemoryTraceStore();

    const tracer = new Tracer(traceStore);
    await tracer.trace("agent.turn", { userInput: secretInput }, async (turn) => {
        const result = await queryModelJson({
        queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify({
            value: secretOutput,
        })), tracer),
        model: "deepseek-v4-pro",
        systemPrompt: secretPrompt,
        userContent: secretInput,
        schema: z.object({ value: z.string() }).strict(),
        abortSignal: new AbortController().signal,
        });
        turn.setOutput({ answer: JSON.stringify(result) });
    });

    const events = traceStore.list();
    assert.deepEqual(events.map((event) => event.name), ["agent.turn", "model.generate"]);
    assert.deepEqual(events.map((event) => event.status), ["ok", "ok"]);
    assert.equal(events[1]?.parentSpanId, events[0]?.spanId);
    assert.equal(events.filter((event) => event.name === "model.generate").length, 1);
    assert.deepEqual(events[1]?.input, {
        provider: "fake",
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: secretInput }],
        systemPrompt: secretPrompt,
        temperature: 0,
        responseFormat: "json_object",
        thinking: "disabled",
    });
    assert.deepEqual(events[1]?.output, {
        type: "text",
        content: JSON.stringify({ value: secretOutput }),
        stopReason: "end_turn",
    });
    assert.deepEqual(events[1]?.tokenUsage, { inputTokens: 1, outputTokens: 1 });
    assert.equal(typeof events[1]?.durationMs, "number");
    const serialized = JSON.stringify(events);
    assert.match(serialized, new RegExp(secretPrompt));
    assert.match(serialized, new RegExp(secretInput));
    assert.match(serialized, new RegExp(secretOutput));
    assert.match(serialized, /"systemPrompt":|"messages":|"content":/);
    assert.match(serialized, /inputTokens/);
    assert.match(serialized, /outputTokens/);
    assert.match(serialized, /stopReason/);
});

test("queryModelJson 非 text 响应保持固定业务错误", async () => {
    const provider: LLMProvider = {
        name: "tool-provider",
        async *stream(): AsyncIterable<StreamEvent> {
            yield { type: "tool_call_start", index: 0, id: "call-1", name: "submit" };
            yield { type: "tool_call_delta", index: 0, argumentsDelta: "{}" };
            yield { type: "tool_call_end", index: 0 };
            yield { type: "message_end", usage: { inputTokens: 2, outputTokens: 1 }, stopReason: "tool_use" };
        },
        async countTokens() { return 0; },
    };
    await assert.rejects(() => queryModelJson({
        queryEngine: new QueryEngine(provider), model: "m", systemPrompt: "s", userContent: "u",
        schema: z.object({ value: z.string() }).strict(), abortSignal: new AbortController().signal,
    }), /结构化任务未返回文本/);
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

    const tracer = new Tracer(traceStore);
    await assert.rejects(
        () => tracer.trace("agent.turn", { userInput: "输入" }, () => queryModelJson({
            queryEngine: new QueryEngine(provider, tracer),
            model: "deepseek-v4-pro",
            systemPrompt: "只输出 JSON。",
            userContent: "输入",
            schema: z.object({ value: z.string() }).strict(),
            abortSignal: new AbortController().signal,
        })),
        (error: unknown) => {
            assert.equal((error as Error).message, "结构化模型请求失败");
            return true;
        },
    );

    const events = traceStore.list();
    assert.deepEqual(events.map((event) => event.name), ["agent.turn", "model.generate"]);
    assert.deepEqual(events.map((event) => event.status), ["error", "error"]);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, new RegExp(secret));
    assert.equal(events[1]?.error?.message, undefined);
    assert.equal(events[0]?.error?.message, "结构化模型请求失败");
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
        const tracer = new Tracer(traceStore);
        await assert.rejects(
            () => tracer.trace("agent.turn", { userInput: "输入" }, () => queryModelJson({
                queryEngine: new QueryEngine(provider, tracer),
                model: "deepseek-v4-pro",
                systemPrompt: "只输出 JSON。",
                userContent: "输入",
                schema: z.object({ value: z.string() }).strict(),
                abortSignal: new AbortController().signal,
            })),
            (error: unknown) => {
                assert.equal((error as Error).name, "AbortError");
                assert.equal((error as Error).message, "操作已中止");
                return true;
            },
        );
        const events = traceStore.list();
        assert.deepEqual(events.map((event) => event.name), ["agent.turn", "model.generate"]);
        assert.deepEqual(events.map((event) => event.status), ["error", "error"]);
        assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
        assert.equal(events[0]?.error?.message, "操作已中止");
        assert.equal(events[1]?.error?.message, undefined);
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
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    await assert.rejects(
        () => tracer.trace("agent.turn", { userInput: "输入" }, () => queryModelJson({
            queryEngine: new QueryEngine(provider, tracer),
            model: "deepseek-v4-pro",
            systemPrompt: "只输出 JSON。",
            userContent: "输入",
            schema: z.object({ value: z.string() }).strict(),
            abortSignal: controller.signal,
        })),
        (error: unknown) => (error as Error).name === "AbortError",
    );
    assert.equal(providerCalled, false);
    assert.deepEqual(traceStore.list().map((event) => event.name), ["agent.turn"]);
});
