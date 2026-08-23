import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "../src/index.js";

test("withSession 继承到根和子 Span，且同一 Trace 不允许污染 session", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await tracer.withSession("session-1", () => tracer.trace("agent.turn", { userInput: "hello" }, async (turn) => {
        turn.setOutput({ answer: "ok" });
        await tracer.span("agent.step", { step: 1 }, async (step) => {
            step.setOutput({ outcome: "answer", stopReason: "end_turn", toolCallCount: 0 });
        });
    }));
    assert.equal(store.listBySession("session-1").length, 2);
    await tracer.withSession("session-1", () => tracer.trace("agent.turn", { userInput: "outer" }, async () => {
        await assert.rejects(tracer.withSession("session-2", () => tracer.span("tool.execute", {
            toolCallId: "id", name: "x", input: {},
        }, async () => undefined)), /session mismatch/);
    }));
});

test("spanSync 在 active Trace 中保持父子关系", async () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    await tracer.trace("agent.turn", { userInput: "sync" }, async (turn) => {
        tracer.spanSync("artifact.put", { kind: "file_text", metadata: {} }, (span) => {
            span.setOutput({ artifactId: "artifact-1" });
            return undefined;
        });
        turn.setOutput({ answer: "ok" });
    });
    const artifact = store.list().find((span) => span.name === "artifact.put")!;
    assert.equal(artifact.parentSpanId, store.list().find((span) => span.name === "agent.turn")?.spanId);
});
