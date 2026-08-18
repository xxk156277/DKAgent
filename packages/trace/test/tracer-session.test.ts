import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "../src/index.js";

test("withSession 让根 Trace、子 Span 和 Event 继承 sessionId", async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer(store);

  await tracer.withSession("session-1", () => tracer.trace(
    "agent.turn",
    { input: "你好" },
    async () => tracer.span("model.request", {}, async (span) => {
      span.event("context.tokens.counted", { tokens: 12 });
    }),
  ));

  const events = store.list();
  assert.ok(events.length > 0);
  assert.equal(events.every((event) => event.sessionId === "session-1"), true);
});

test("未绑定 Session 时保持旧事件兼容", async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer(store);

  await tracer.trace("agent.turn", { input: "你好" }, async () => undefined);

  assert.equal(store.list().every((event) => event.sessionId === undefined), true);
});
