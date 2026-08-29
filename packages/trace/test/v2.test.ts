import assert from "node:assert/strict";
import test from "node:test";
import {
    MemoryTraceStore,
    Tracer,
    type AnyTraceSpan,
    type SpanChange,
    type TraceSink,
} from "../src/index.js";

test("typed spans record root/child snapshots and per-trace sequence", async () => {
    const store = new MemoryTraceStore(100);
    const tracer = new Tracer(store);

    await tracer.trace("agent.turn", { userInput: "hello" }, async (turn) => {
        turn.setOutput({ answer: "ok" });
        await tracer.span("agent.step", { step: 1 }, async (step) => {
            step.setOutput({ outcome: "answer", stopReason: "end_turn", toolCallCount: 0 });
        });
    });

    const spans = store.list();
    assert.deepEqual(spans.map((span) => span.name), ["agent.turn", "agent.step"]);
    assert.deepEqual(spans.map((span) => span.sequence), [1, 2]);
    assert.equal(spans[1]?.parentSpanId, spans[0]?.spanId);
    assert.equal(spans.every((span) => span.revision >= 1), true);
    assert.equal(spans.every((span) => span.integrity), true);
});

test("span without active trace is a business no-op, and spanSync follows it", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    let called = 0;

    const asyncResult = await tracer.span("tool.execute", {
        toolCallId: "call-1",
        name: "noop",
        input: {},
    }, async (span) => {
        called += 1;
        span.setOutput({ success: true });
        return 42;
    });
    const syncResult = tracer.spanSync("tool.execute", {
        toolCallId: "call-2",
        name: "noop",
        input: {},
    }, (span) => {
        called += 1;
        span.setOutput({ success: true });
        return 7;
    });

    assert.equal(asyncResult, 42);
    assert.equal(syncResult, 7);
    assert.equal(called, 2);
    assert.deepEqual(store.list(), []);
});

test("revision advances for event and terminal snapshots; stale revisions are ignored", async () => {
    const store = new MemoryTraceStore();
    const changes: SpanChange[] = [];
    store.subscribe((change) => changes.push(change));
    const tracer = new Tracer(store);

    await tracer.trace("agent.turn", { userInput: "event" }, async (span) => {
        span.event("context.tokens.counted", { tokens: 1 });
        span.setOutput({ answer: "done" });
    });

    const root = store.list()[0]!;
    assert.equal(changes.map((change) => change.type).join(","), "span_started,span_updated,span_ended");
    assert.equal(root.revision, 3);
    assert.equal(store.upsert({ ...root, revision: 1, status: "running", endedAt: undefined }), undefined);
    assert.equal(store.list()[0]?.revision, 3);
});

test("missing output marks integrity incomplete but keeps successful business result", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const result = await tracer.trace("agent.turn", { userInput: "missing" }, async () => "ok");
    const span = store.list()[0]!;
    assert.equal(result, "ok");
    assert.equal(span.status, "ok");
    assert.equal(span.output, null);
    assert.equal(span.integrity, false);
    assert.deepEqual(span.events[0]?.data, { code: "TRACE_OUTPUT_MISSING" });
});

test("model failures retain business error identity but store only safe error fields", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const expected = Object.assign(new Error("provider raw secret"), { code: "UPSTREAM" });
    await assert.rejects(
        tracer.trace("agent.turn", { userInput: "model" }, async () => tracer.span(
            "model.generate",
            { provider: "fake", model: "fake", messages: [] },
            async () => { throw expected; },
        )),
        (error) => error === expected,
    );
    const model = store.list().find((span) => span.name === "model.generate")!;
    assert.deepEqual(model.error, { name: "Error", code: "UPSTREAM" });
    assert.equal(JSON.stringify(model).includes("provider raw secret"), false);
});

test("runtime cannot create a non-agent.turn root or disable model error safety", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await assert.rejects((tracer as never as { trace: (...args: unknown[]) => Promise<unknown> }).trace(
        "model.generate", { provider: "fake", model: "fake", messages: [] }, async () => undefined,
    ), /agent.turn/);
    assert.equal(store.list().length, 0);
    const expected = new Error("provider secret");
    await assert.rejects(tracer.trace("agent.turn", { userInput: "safe" }, async () => tracer.span(
        "model.generate", { provider: "fake", model: "fake", messages: [] }, async () => { throw expected; },
        { safeError: false } as never,
    )), (error) => error === expected);
    assert.equal(JSON.stringify(store.list()).includes("provider secret"), false);
});

test("concurrent sessions do not cross-contaminate trace context", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await Promise.all(["s1", "s2"].map((sessionId) => tracer.withSession(sessionId, async () => {
        await tracer.trace("agent.turn", { userInput: sessionId }, async (span) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            span.setOutput({ answer: sessionId });
        });
    })));
    assert.deepEqual(new Set(store.list().map((span) => span.sessionId)), new Set(["s1", "s2"]));
    for (const sessionId of ["s1", "s2"]) {
        assert.deepEqual(store.listBySession(sessionId).map((span) => span.input), [{ userInput: sessionId }]);
    }
});

test("circular values degrade integrity without changing business result or error identity", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const expected = new Error("business failure");

    const result = await tracer.trace("agent.turn", { userInput: "circular" }, async (span) => {
        span.event("context.tokens.counted", circular as never);
        span.setOutput(circular as never);
        return "business result";
    });
    assert.equal(result, "business result");
    assert.equal(store.list()[0]?.integrity, false);
    assert.equal(store.list()[0]?.events.some((event) => event.name === "trace.serialization_error"), true);

    await assert.rejects(
        tracer.trace("agent.turn", { userInput: "error" }, async () => { throw expected; }),
        (error) => error === expected,
    );
    assert.equal(store.list().find((span) => span.input.userInput === "error")?.error?.message, "business failure");
});

test("sink and listener failures are isolated; sensitive fields are recursively redacted", async () => {
    const store = new MemoryTraceStore();
    store.subscribe(() => { throw new Error("listener down"); });
    let secondListenerCalls = 0;
    store.subscribe(() => { secondListenerCalls += 1; });
    const received: AnyTraceSpan[] = [];
    const tracer = new Tracer({
        upsert(span) {
            received.push(span);
            store.upsert(span);
            if (received.length === 1) throw new Error("sink down");
        },
    });
    await tracer.trace("agent.turn", {
        userInput: "hello",
    }, async (span) => {
        span.setOutput({ answer: "ok" });
        span.event("context.tokens.counted", {
            nested: { apiKey: "secret", authorization: "Bearer secret", value: "keep" },
        });
    });
    assert.equal(received.length >= 2, true);
    assert.equal(JSON.stringify(received).includes("secret"), false);
    assert.equal(JSON.stringify(received).includes("keep"), true);
    assert.equal(secondListenerCalls > 0, true);
});

test("连续 sink 失败只通知一次，成功后下一次失败重新通知", async () => {
    let attempts = 0;
    const notified: unknown[] = [];
    const tracer = new Tracer({
        upsert() {
            attempts += 1;
            if (attempts <= 2 || attempts === 4) throw new Error(`sink-${attempts}`);
        },
    }, { onWriteError: (error) => notified.push(error) });
    for (let index = 0; index < 3; index += 1) {
        await tracer.trace("agent.turn", { userInput: String(index) }, async (span) => {
            span.setOutput({ answer: String(index) });
        });
    }
    assert.equal(notified.length, 2);
});

test("more than 100 spans remain bounded by store capacity", async () => {
    const store = new MemoryTraceStore(100);
    const tracer = new Tracer(store);
    for (let index = 0; index < 101; index += 1) {
        await tracer.trace("agent.turn", { userInput: String(index) }, async (span) => {
            span.setOutput({ answer: String(index) });
        });
    }
    assert.equal(store.list().length, 100);

    const defaultStore = new MemoryTraceStore();
    const defaultTracer = new Tracer(defaultStore);
    for (let index = 0; index < 101; index += 1) {
        await defaultTracer.trace("agent.turn", { userInput: String(index) }, async (span) => {
            span.setOutput({ answer: String(index) });
        });
    }
    assert.equal(defaultStore.list(101).length, 101);
    assert.equal(defaultStore.list().length, 100);
});

test("reader limits are bounded and returned snapshots are defensive copies", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await tracer.trace("agent.turn", { userInput: "limit" }, async (span) => span.setOutput({ answer: "ok" }));
    for (const invalid of [0, -1, 1.5, 1001, Infinity]) {
        assert.throws(() => store.list(invalid), /1～1000/);
    }
    const copy = store.list()[0]!;
    copy.input.userInput = "mutated";
    assert.equal(store.list()[0]?.input.userInput, "limit");
});

test("invalid runtime values become safe markers and final snapshots stay JSON-safe", async () => {
    const values: unknown[] = [
        1n, undefined, new Map([["key", "value"]]), Number.NaN, Number.POSITIVE_INFINITY,
        () => "function",
    ];
    for (const value of values) {
        const store = new MemoryTraceStore();
        const tracer = new Tracer(store);
        await tracer.trace("agent.turn", { userInput: "json" }, async (span) => {
            span.event("context.tokens.counted", value as never);
            span.setOutput({ answer: "ok" });
        });
        assert.doesNotThrow(() => JSON.stringify(store.list()));
        assert.equal(store.list()[0]?.integrity, false);
    }
});

test("no-active model span exposes a no-op token usage setter", async () => {
    const tracer = new Tracer();
    const result = await tracer.span("model.generate", {
        provider: "fake", model: "fake", messages: [],
    }, async (span) => {
        span.setTokenUsage({ inputTokens: 1, outputTokens: 2 });
        return "ok";
    });
    assert.equal(result, "ok");
});

test("error finish does not invent output_missing or downgrade integrity", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const expected = new Error("business");
    await assert.rejects(tracer.trace("agent.turn", { userInput: "error" }, async () => {
        throw expected;
    }), (error) => error === expected);
    const span = store.list()[0]!;
    assert.equal(span.status, "error");
    assert.equal(span.integrity, true);
    assert.equal(span.events.some((event) => event.name === "trace.output_missing"), false);
});

test("spanSync rejects a PromiseLike callback as a programming error and does not end ok", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await assert.rejects(tracer.trace("agent.turn", { userInput: "sync" }, async () => {
        tracer.spanSync("tool.execute", {
            toolCallId: "call", name: "tool", input: {},
        }, (() => Promise.resolve("wrong")) as never);
    }), /spanSync/);
    assert.equal(store.list().some((span) => span.name === "tool.execute" && span.status === "ok"), false);
});

test("terminal first snapshot is ended and identity cannot be overwritten", () => {
    const store = new MemoryTraceStore();
    const changes: SpanChange[] = [];
    store.subscribe((change) => changes.push(change));
    const span = {
        schemaVersion: 2, traceId: "trace", spanId: "span", name: "agent.turn", kind: "AGENT",
        status: "ok", sequence: 1, revision: 1, startedAt: "now", endedAt: "later", durationMs: 1,
        input: { userInput: "x" }, output: { answer: "ok" }, tokenUsage: null, attributes: {}, events: [], integrity: true,
    } as const;
    store.upsert(span);
    store.upsert({ ...span, revision: 2, status: "running", sequence: 99, traceId: "other", name: "agent.step" } as never);
    assert.equal(changes[0]?.type, "span_ended");
    assert.deepEqual(store.list()[0], span);
});

test("concurrent sibling spans receive unique monotonic sequence values", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await tracer.trace("agent.turn", { userInput: "siblings" }, async (root) => {
        await Promise.all([1, 2, 3].map((step) => tracer.span("agent.step", { step }, async (span) => {
            span.setOutput({ outcome: "answer", stopReason: "end_turn", toolCallCount: 0 });
        })));
        root.setOutput({ answer: "ok" });
    });
    const sequences = store.list().filter((span) => span.name === "agent.step").map((span) => span.sequence);
    assert.deepEqual(new Set(sequences).size, 3);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test("clone catches hostile getters and proxies without changing business result", async () => {
    const hostile = () => new Proxy({}, { getPrototypeOf: () => { throw new Error("prototype trap"); } });
    const getterHostile = () => Object.defineProperty({}, "boom", { enumerable: true, get: () => { throw new Error("getter trap"); } });
    const ownKeysHostile = () => new Proxy({}, { ownKeys: () => { throw new Error("keys trap"); } });
    const deepHostile = () => {
        const root: Record<string, unknown> = {};
        let node = root;
        for (let index = 0; index < 12_000; index += 1) { node.next = {}; node = node.next as Record<string, unknown>; }
        return root;
    };
    const cases: Array<(tracer: Tracer) => Promise<unknown>> = [
        (tracer) => tracer.trace("agent.turn", hostile() as never, async (span) => { span.setOutput({ answer: "ok" }); return "input"; }),
        (tracer) => tracer.trace("agent.turn", { userInput: "output" }, async (span) => { span.setOutput(hostile() as never); return "output"; }),
        (tracer) => tracer.trace("agent.turn", { userInput: "attributes" }, async (span) => {
            span.setOutput({ answer: "ok" });
            return tracer.span("tool.execute", { toolCallId: "x", name: "x", input: {} }, async (child) => {
                child.setOutput({ success: true }); return "attributes";
            }, { attributes: hostile() as never });
        }),
        (tracer) => tracer.trace("agent.turn", { userInput: "event" }, async (span) => { span.event("context.tokens.counted", hostile() as never); span.setOutput({ answer: "ok" }); return "event"; }),
        (tracer) => tracer.trace("agent.turn", { userInput: "usage" }, async () => tracer.span("model.generate", { provider: "fake", model: "fake", messages: [] }, async (span) => {
            span.setTokenUsage(hostile() as never); span.setOutput({ type: "text", content: "ok", stopReason: "end" }); return "usage";
        })),
        (tracer) => tracer.trace("agent.turn", getterHostile() as never, async (span) => { span.setOutput({ answer: "ok" }); return "getter"; }),
        (tracer) => tracer.trace("agent.turn", ownKeysHostile() as never, async (span) => { span.setOutput({ answer: "ok" }); return "keys"; }),
        (tracer) => tracer.trace("agent.turn", deepHostile() as never, async (span) => { span.setOutput({ answer: "ok" }); return "deep"; }),
    ];
    for (const run of cases) {
        const store = new MemoryTraceStore();
        const result = await run(new Tracer(store));
        assert.equal(typeof result, "string");
        assert.equal(store.list().some((span) => !span.integrity && span.events.some((event) => event.name === "trace.serialization_error")), true);
        assert.doesNotThrow(() => JSON.stringify(store.list()));
    }
});

test("primitive Provider errors are safe in model and all ancestor spans", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const raw = "provider-primitive-secret";
    await assert.rejects(tracer.trace("agent.turn", { userInput: "primitive" }, async () => tracer.span("model.generate", {
        provider: "fake", model: "fake", messages: [],
    }, async () => { throw raw; })), (error) => error === raw);
    for (const span of store.list()) {
        if (span.status === "error") {
            assert.equal(span.error?.message, undefined);
            assert.equal(JSON.stringify(span).includes(raw), false);
        }
    }
});

test("escaped handles close after terminal and no-active PromiseLike is observed", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    let escaped: import("../src/index.js").TraceSpanHandle<"tool.execute"> | undefined;
    await tracer.trace("agent.turn", { userInput: "closed" }, async (root) => {
        await tracer.span("tool.execute", { toolCallId: "x", name: "x", input: {} }, async (span) => {
            escaped = span;
            span.setOutput({ success: true });
        });
        root.setOutput({ answer: "ok" });
    });
    const before = store.list().find((span) => span.name === "tool.execute")!;
    escaped!.setOutput({ success: false });
    escaped!.event("context.tokens.counted", { late: true });
    assert.deepEqual(store.list().find((span) => span.spanId === before.spanId), before);
    assert.throws(() => tracer.spanSync("tool.execute", { toolCallId: "x", name: "x", input: {} }, (() => Promise.reject(new Error("late"))) as never), /spanSync/);
});

test("MemoryStore ignores malformed runtime snapshots and isolates listener mutation", () => {
    const store = new MemoryTraceStore();
    const valid = {
        schemaVersion: 2, traceId: "trace", spanId: "span", name: "agent.turn", kind: "AGENT",
        status: "running", sequence: 1, revision: 1, startedAt: "now", input: { userInput: "x" }, output: null,
        tokenUsage: null, attributes: {}, events: [], integrity: true,
    } as const;
    const malformed = [
        { ...valid, schemaVersion: 1 }, { ...valid, name: "unknown" }, { ...valid, kind: "TOOL" },
        { ...valid, status: "wat" }, { ...valid, revision: Infinity }, { ...valid, sequence: 0 },
        { ...valid, input: { value: 1n } },
    ];
    for (const span of malformed) assert.doesNotThrow(() => store.upsert(span as never));
    let second: AnyTraceSpan | undefined;
    store.subscribe((change) => { change.span.status = "error"; });
    store.subscribe((change) => { second = change.span; });
    store.upsert(valid);
    assert.equal(second?.status, "running");
    assert.equal(store.list().length, 1);
});

test("safe primitive errors are isolated per root and swallowed errors do not poison later traces", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const raw = "same-provider-error";
    await tracer.trace("agent.turn", { userInput: "swallow" }, async (root) => {
        try {
            await tracer.span("model.generate", { provider: "fake", model: "fake", messages: [] }, async () => { throw raw; });
        } catch (error) {
            assert.equal(error, raw);
        }
        root.setOutput({ answer: "recovered" });
    });
    await assert.rejects(tracer.trace("agent.turn", { userInput: "ordinary" }, async () => { throw raw; }), (error) => error === raw);
    const ordinary = store.list().find((span) => span.input.userInput === "ordinary")!;
    assert.equal(ordinary.error?.message, raw);
});

test("hostile error access cannot replace original business exception", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const expected = {};
    Object.defineProperty(expected, "name", { get: () => { throw new Error("name trap"); } });
    Object.defineProperty(expected, "message", { get: () => { throw new Error("message trap"); } });
    await assert.rejects(tracer.trace("agent.turn", { userInput: "hostile-error" }, async () => { throw expected; }), (error) => error === expected);
    assert.deepEqual(store.list()[0]?.error, { name: "Error" });
});

test("prototype-chain names are rejected without executing callbacks or writing", async () => {
    const received: AnyTraceSpan[] = [];
    const store = new MemoryTraceStore();
    const tracer = new Tracer({ upsert: (span) => received.push(span) });
    const callbackNames = ["toString", "constructor", "__proto__"];
    for (const name of callbackNames) {
        let called = false;
        await assert.rejects((tracer as never as { span: (...args: unknown[]) => Promise<unknown> }).span(
            name, {}, async () => { called = true; },
        ), /未知 Span name/);
        assert.equal(called, false);
        assert.throws(() => (tracer as never as { spanSync: (...args: unknown[]) => unknown }).spanSync(
            name, {}, () => { called = true; },
        ), /未知 Span name/);
        assert.equal(called, false);
    }
    for (const name of callbackNames) {
        store.upsert({
            schemaVersion: 2, traceId: "trace", spanId: name, name, kind: "AGENT", status: "running",
            sequence: 1, revision: 1, startedAt: "now", input: {}, output: null, tokenUsage: null,
            attributes: {}, events: [], integrity: true,
        } as never);
    }
    assert.equal(received.length, 0);
    assert.equal(store.list().length, 0);
});
