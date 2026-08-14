import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "../../src/session/store.js";

test("关闭数据库后仍能恢复最近 Session 的消息和 Context 状态", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const databasePath = join(directory, "sessions.db");
    const firstStore = new SqliteSessionStore(databasePath);
    const session = firstStore.create();

    firstStore.appendMessage(session.id, { role: "user", content: "第一轮问题" });
    firstStore.appendMessage(session.id, {
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "demo", input: { value: 1 } }],
    });
    firstStore.appendMessage(session.id, {
        role: "tool",
        toolCallId: "call-1",
        content: "{\"ok\":true}",
    });
    firstStore.saveContextState(session.id, {
        summary: "已经讨论第一轮问题",
        firstKeptMessageIndex: 1,
    });
    firstStore.close();

    const secondStore = new SqliteSessionStore(databasePath);
    const restored = secondStore.loadLatest();

    assert.equal(restored?.id, session.id);
    assert.deepEqual(restored?.messages, [
        { role: "user", content: "第一轮问题" },
        {
            role: "assistant",
            toolCalls: [{ id: "call-1", name: "demo", input: { value: 1 } }],
        },
        { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
    ]);
    assert.deepEqual(restored?.contextState, {
        summary: "已经讨论第一轮问题",
        firstKeptMessageIndex: 1,
    });
    secondStore.close();
});

test("创建新 Session 后最近 Session 为空且旧消息仍保留", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const store = new SqliteSessionStore(join(directory, "sessions.db"));
    const oldSession = store.create();
    store.appendMessage(oldSession.id, { role: "user", content: "旧问题" });

    const newSession = store.create();
    const latest = store.loadLatest();

    assert.equal(latest?.id, newSession.id);
    assert.deepEqual(latest?.messages, []);
    assert.notEqual(newSession.id, oldSession.id);
    store.close();
});
