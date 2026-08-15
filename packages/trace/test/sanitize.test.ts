import assert from "node:assert/strict";
import test from "node:test";
import {
    sanitizeTraceEvent,
    Tracer,
    type TraceEvent,
    type TraceSink,
} from "../src/index.js";

const memoryFact = "用户偏好先讲结论";

function traceEvent(data: unknown): TraceEvent {
    return {
        id: "event-1",
        traceId: "trace-1",
        sequence: 1,
        timestamp: "2026-08-16T00:00:00.000Z",
        name: "context.build",
        phase: "start",
        data,
    };
}

test("sanitizeTraceEvent 替换任意字符串中的 recalled memory 块", () => {
    const sanitized = sanitizeTraceEvent(traceEvent({
        systemPrompt: [
            "规则",
            `<recalled_memory>${memoryFact}</recalled_memory>`,
            `<recalled_memory>${memoryFact}</recalled_memory>`,
        ].join("\n"),
        nested: { value: `<recalled_memory>${memoryFact}</recalled_memory>` },
        ordinaryText: "普通用户文本保持原样",
    }));

    assert.doesNotMatch(JSON.stringify(sanitized), new RegExp(memoryFact));
    assert.match(JSON.stringify(sanitized), /\[RECALLED_MEMORY_REDACTED\]/);
    assert.match(JSON.stringify(sanitized), /普通用户文本保持原样/);
});

test("Tracer 在调用任意 sink 前脱敏 recalled memory", async () => {
    const received: TraceEvent[] = [];
    const sink: TraceSink = {
        emit(event) {
            received.push(event);
        },
    };
    const tracer = new Tracer(sink);

    await tracer.trace(
        "agent.turn",
        { systemPrompt: `<recalled_memory>${memoryFact}</recalled_memory>` },
        async () => undefined,
    );

    assert.doesNotMatch(JSON.stringify(received), new RegExp(memoryFact));
    assert.match(JSON.stringify(received), /\[RECALLED_MEMORY_REDACTED\]/);
});
