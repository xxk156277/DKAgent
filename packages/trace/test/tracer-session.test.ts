import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryTraceStore,
  Tracer,
  type TraceEventName,
  type TraceModule,
} from "../src/index.js";

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

test("Skill Span 的生命周期和子 Event 继承 module 与 operation", async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer(store);

  await tracer.trace("agent.turn", { input: "分析答案" }, async () => tracer.span(
    "skill.stage",
    { stage: "analyze" },
    async (span) => {
      tracer.event("model.request", { prompt: "答案" });
      span.event("model.response", { output: "分析结果" });
    },
    { module: "skill", operation: "analyze_answer" },
  ));

  const skillEvents = store.list().filter((event) => event.name !== "agent.turn");
  assert.deepEqual(skillEvents.map((event) => event.name), [
    "skill.stage",
    "model.request",
    "model.response",
    "skill.stage",
  ]);
  assert.equal(skillEvents.every((event) => event.module === "skill"), true);
  assert.equal(skillEvents.every((event) => event.operation === "analyze_answer"), true);
});

test("Artifact Trace 类型可从公共入口导入", () => {
  const module: TraceModule = "artifact";
  const names: TraceEventName[] = ["artifact.created", "artifact.resolved"];

  assert.equal(module, "artifact");
  assert.equal(names.length, 2);
});
