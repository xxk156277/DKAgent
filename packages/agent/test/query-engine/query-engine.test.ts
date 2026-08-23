import assert from "node:assert/strict";
import test from "node:test";
import type {
    AgentMessage,
    LLMProvider,
    ModelRequest,
    StreamEvent,
    ToolSchema,
} from "../../src/query-engine/provider.js";
import { ToolInputParseError } from "../../src/query-engine/stream-parser.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";

class FakeProvider implements LLMProvider {
    public readonly name = "fake";
    public request: ModelRequest | undefined;
    public streamCalls = 0;

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        this.streamCalls += 1;
        this.request = request;
        yield { type: "text_delta", content: "完成" };
        yield {
            type: "message_end",
            usage: { inputTokens: 3, outputTokens: 1 },
            stopReason: "end_turn",
        };
    }

    public async countTokens(
        _messages: AgentMessage[],
        _tools?: ToolSchema[],
    ): Promise<number> {
        return 0;
    }
}

test("QueryEngine 只转发请求并解析 Provider Stream", async () => {
    const provider = new FakeProvider();
    const engine = new QueryEngine(provider);
    const messages: AgentMessage[] = [{ role: "user", content: "开始" }];
    const before = structuredClone(messages);
    const deltas: string[] = [];
    const request: ModelRequest = {
        model: "fake-model",
        messages,
        temperature: 0,
        onTextDelta: (text) => deltas.push(text),
    };

    const response = await engine.query(request);

    assert.equal(provider.request, request);
    assert.deepEqual(messages, before);
    assert.deepEqual(deltas, ["完成"]);
    assert.deepEqual(response, {
        type: "text",
        content: "完成",
        usage: { inputTokens: 3, outputTokens: 1 },
        stopReason: "end_turn",
    });
});

test("active trace owns one model.generate with request DTO, parent, usage and duration", async () => {
    const provider = new FakeProvider();
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    const deltas: string[] = [];
    const request: ModelRequest = {
        model: "fake-model", systemPrompt: "system", messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read", description: "read", parameters: { type: "object" } }], maxTokens: 20,
        temperature: 0, responseFormat: "json_object", thinking: "disabled", abortSignal: new AbortController().signal,
        onTextDelta: (text) => deltas.push(text),
    };
    await tracer.trace("agent.turn", { userInput: "hi" }, async (root) => {
        await engine.query(request);
        root.setOutput({ answer: "完成" });
    });
    assert.equal(provider.streamCalls, 1);
    assert.equal(provider.request, request);
    assert.deepEqual(deltas, ["完成"]);
    const spans = store.list();
    const root = spans.find((span) => span.name === "agent.turn")!;
    const model = spans.find((span) => span.name === "model.generate")!;
    assert.equal(spans.filter((span) => span.name === "model.generate").length, 1);
    assert.equal(model.parentSpanId, root.spanId);
    assert.equal(model.input.provider, "fake");
    assert.equal(model.input.model, request.model);
    assert.equal("onTextDelta" in model.input, false);
    assert.equal("abortSignal" in model.input, false);
    assert.deepEqual(model.input, {
        provider: "fake", model: request.model, systemPrompt: "system", messages: request.messages,
        tools: request.tools, maxTokens: 20, temperature: 0, responseFormat: "json_object", thinking: "disabled",
    });
    assert.deepEqual(model.output, { type: "text", content: "完成", stopReason: "end_turn" });
    assert.deepEqual(model.tokenUsage, { inputTokens: 3, outputTokens: 1 });
    assert.equal(typeof model.durationMs, "number");
});

test("stream failure after yielded events preserves identity and safe errors", async () => {
    const expected = new Error("stream provider secret");
    const provider: LLMProvider = {
        name: "fake",
        async *stream() {
            yield { type: "text_delta", content: "partial" };
            throw expected;
        },
        async countTokens() { return 0; },
    };
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    await assert.rejects(tracer.trace("agent.turn", { userInput: "stream-error" }, async () => engine.query({ model: "fake", messages: [] })), (error) => error === expected);
    for (const span of store.list().filter((item) => item.status === "error")) {
        assert.equal(span.error?.message, undefined);
        assert.equal(JSON.stringify(span).includes("stream provider secret"), false);
    }
});

test("malformed tool JSON preserves ToolInputParseError identity and safe model error", async () => {
    const provider: LLMProvider = {
        name: "fake",
        async *stream() {
            yield { type: "tool_call_start", index: 0, id: "call-1", name: "read_file" };
            yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":' };
            yield { type: "tool_call_end", index: 0 };
            yield { type: "message_end", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" };
        },
        async countTokens() { return 0; },
    };
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    let expected: unknown;
    await assert.rejects(tracer.trace("agent.turn", { userInput: "bad-tool" }, async () => {
        try { await engine.query({ model: "fake", messages: [] }); } catch (error) { expected = error; throw error; }
    }), (error) => error === expected && error instanceof ToolInputParseError);
    assert.equal(store.list().filter((span) => span.status === "error").every((span) => span.error?.message === undefined), true);
});

test("tool_use response is recorded without duplicating usage", async () => {
    const provider: LLMProvider = {
        name: "fake",
        async *stream() {
            yield { type: "tool_call_start", index: 0, id: "call-1", name: "read_file" };
            yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"a"}' };
            yield { type: "tool_call_end", index: 0 };
            yield { type: "message_end", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 4, cacheWriteTokens: 0 }, stopReason: "tool_use" };
        },
        async countTokens() { return 0; },
    };
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    await tracer.trace("agent.turn", { userInput: "tool" }, async (root) => {
        await engine.query({ model: "fake", messages: [{ role: "user", content: "read" }] });
        root.setOutput({ answer: "tool" });
    });
    const model = store.list().find((span) => span.name === "model.generate")!;
    assert.deepEqual(model.output, {
        type: "tool_use", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a" } }], stopReason: "tool_use",
    });
    assert.deepEqual(model.tokenUsage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 4, cacheWriteTokens: 0 });
});

test("provider and parser errors preserve identity and do not persist raw message", async () => {
    const expected = new Error("provider secret");
    const provider: LLMProvider = {
        name: "fake", stream: () => { throw expected; }, async countTokens() { return 0; },
    };
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    await assert.rejects(tracer.trace("agent.turn", { userInput: "error" }, async () => engine.query({ model: "fake", messages: [] })), (error) => error === expected);
    for (const span of store.list().filter((item) => item.status === "error")) {
        assert.equal(span.error?.message, undefined);
        assert.equal(JSON.stringify(span).includes("provider secret"), false);
    }
});

test("circular tool parameters stay original for Provider but degrade model trace safely", async () => {
    const provider = new FakeProvider();
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const engine = new QueryEngine(provider, tracer);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const request: ModelRequest = {
        model: "fake", messages: [{ role: "user", content: "x" }],
        tools: [{ name: "tool", description: "tool", parameters: { circular } }],
    };
    await tracer.trace("agent.turn", { userInput: "circular" }, async (root) => {
        await engine.query(request);
        root.setOutput({ answer: "ok" });
    });
    assert.equal(provider.request, request);
    const model = store.list().find((span) => span.name === "model.generate")!;
    assert.equal(model.integrity, false);
    assert.equal(model.events.some((event) => event.name === "trace.serialization_error"), true);
});
