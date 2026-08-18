import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore } from "@dkagent/trace";
import { createTapSessionReader } from "../src/tap/session-reader.js";

test("Session Reader 生成 Tap 展示字段且不修改 Agent Session 类型", () => {
  const traceStore = new MemoryTraceStore();
  traceStore.emit({
    sessionId: "session-1",
    id: "event-1",
    traceId: "turn-1",
    sequence: 1,
    timestamp: "2026-08-18T00:00:02.000Z",
    name: "agent.turn",
    phase: "start",
    data: { input: "你好" },
  });
  const sessionStore = {
    list: () => [{
      id: "session-1",
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:03.000Z",
    }],
    load: (sessionId: string) => sessionId === "session-1" ? {
      id: sessionId,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:03.000Z",
      messages: [
        { role: "system", content: "系统规则" },
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
      ],
      contextState: { summary: "旧对话摘要", firstKeptMessageIndex: 1 },
    } : null,
  };

  const reader = createTapSessionReader(sessionStore, traceStore);

  assert.deepEqual(reader.list(), [{
    id: "session-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:03.000Z",
    preview: "你好",
    messageCount: 3,
    turnCount: 1,
    hasTrace: true,
  }]);
  assert.deepEqual(reader.load("session-1"), {
    id: "session-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:03.000Z",
    messages: sessionStore.load("session-1")?.messages,
    contextSummary: "旧对话摘要",
  });
});

test("没有 Trace 的 Session 保留真实消息并标记 hasTrace=false", () => {
  const sessionStore = {
    list: () => [{ id: "session-old", createdAt: "c", updatedAt: "u" }],
    load: () => ({
      id: "session-old",
      createdAt: "c",
      updatedAt: "u",
      messages: [{ role: "assistant", content: "历史回答" }],
      contextState: { summary: "", firstKeptMessageIndex: 0 },
    }),
  };

  const reader = createTapSessionReader(sessionStore, new MemoryTraceStore());

  assert.equal(reader.list()[0]?.hasTrace, false);
  assert.equal(reader.list()[0]?.preview, "未命名对话");
});
