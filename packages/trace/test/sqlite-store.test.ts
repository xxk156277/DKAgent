import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteTraceStore, Tracer, type SpanChange } from "../src/index.js";

function createSessionDatabase(): { databasePath: string; sessionId: string } {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-trace-sqlite-"));
    const databasePath = join(directory, "sessions.db");
    const sessionId = "session-1";
    const database = new Database(databasePath);
    database.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            summary TEXT NOT NULL DEFAULT '',
            first_kept_message_index INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);
    database.prepare(`
        INSERT INTO sessions (id, created_at, updated_at)
        VALUES (?, ?, ?)
    `).run(sessionId, "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    database.close();
    return { databasePath, sessionId };
}

test("SQLite Trace 在重启后恢复 terminal Span，并忽略 stale revision", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const changes: SpanChange[] = [];
    const firstStore = new SqliteTraceStore(databasePath);
    firstStore.subscribe((change) => changes.push(change));
    const tracer = new Tracer(firstStore);

    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "hello" },
        async (turn) => {
            await tracer.span("agent.step", { step: 1 }, async (step) => {
                step.setOutput({ outcome: "answer", stopReason: "end_turn", toolCallCount: 0 });
            });
            turn.setOutput({ answer: "done" });
        },
    ));
    const traceId = firstStore.listBySession(sessionId)[0]!.traceId;
    const terminalRoot = firstStore.listByTrace(traceId).find((span) => span.name === "agent.turn")!;
    firstStore.upsert({ ...terminalRoot, revision: 1, status: "running", endedAt: undefined } as never);
    assert.equal(changes.some((change) => change.type === "span_ended"), true);
    firstStore.close();

    const secondStore = new SqliteTraceStore(databasePath);
    const restored = secondStore.listByTrace(traceId);
    assert.deepEqual(restored.map((span) => span.name), ["agent.turn", "agent.step"]);
    assert.deepEqual(restored.map((span) => span.status), ["ok", "ok"]);
    assert.equal(restored[0]?.revision, terminalRoot.revision);
    assert.equal(typeof restored[0]?.durationMs, "number");
    assert.deepEqual(restored[0]?.input, { userInput: "hello" });
    secondStore.close();
});

test("model.generate 输入输出不脱敏并在 SQLite 重启后原样恢复", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const firstStore = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(firstStore);

    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "model trace" },
        async (turn) => {
            await tracer.span("model.generate", {
                provider: "fake",
                model: "fake-model",
                messages: [{ role: "user", content: "hello", authorization: "Bearer input-secret" }],
                tools: [{ name: "lookup", apiKey: "tool-secret" }],
            }, async (model) => {
                model.setOutput({
                    type: "tool_use",
                    toolCalls: [{ id: "call-1", name: "lookup", arguments: { password: "output-secret" } }],
                    stopReason: "tool_use",
                });
            });
            turn.setOutput({ answer: "done" });
        },
    ));
    const traceId = firstStore.listBySession(sessionId)[0]!.traceId;
    firstStore.close();

    const secondStore = new SqliteTraceStore(databasePath);
    const model = secondStore.listByTrace(traceId).find((span) => span.name === "model.generate")!;
    assert.deepEqual(model.input.messages, [
        { role: "user", content: "hello", authorization: "Bearer input-secret" },
    ]);
    assert.deepEqual(model.input.tools, [{ name: "lookup", apiKey: "tool-secret" }]);
    assert.deepEqual(model.output, {
        type: "tool_use",
        toolCalls: [{ id: "call-1", name: "lookup", arguments: { password: "output-secret" } }],
        stopReason: "tool_use",
    });
    secondStore.close();
});

test("删除 Session 会级联删除 traces 与 trace_spans", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "delete" },
        async (turn) => turn.setOutput({ answer: "done" }),
    ));
    assert.equal(store.listBySession(sessionId).length, 1);

    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    database.close();

    assert.deepEqual(store.listBySession(sessionId), []);
    store.close();
});

test("SQLite schema 使用规范化关系、REAL duration 和唯一 root", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "schema" },
        async (turn) => turn.setOutput({ answer: "done" }),
    ));
    const root = store.listBySession(sessionId)[0]!;
    store.close();

    const database = new Database(databasePath);
    const spanColumns = database.pragma("table_info(trace_spans)") as Array<{ name: string; type: string }>;
    assert.equal(spanColumns.some((column) => column.name === "session_id"), false);
    assert.equal(spanColumns.find((column) => column.name === "duration_ms")?.type, "REAL");
    const traceForeignKeys = database.pragma("foreign_key_list(traces)") as Array<{ table: string; on_delete: string }>;
    const spanForeignKeys = database.pragma("foreign_key_list(trace_spans)") as Array<{ table: string; on_delete: string }>;
    assert.deepEqual(traceForeignKeys.map((key) => [key.table, key.on_delete]), [["sessions", "CASCADE"]]);
    assert.deepEqual(spanForeignKeys.map((key) => [key.table, key.on_delete]), [["traces", "CASCADE"]]);
    assert.throws(() => database.prepare(`
        INSERT INTO traces (
            trace_id, session_id, root_span_id, started_at, status, revision, integrity, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("other-trace", sessionId, root.spanId, root.startedAt, "ok", 1, 1, root.startedAt), /UNIQUE/);
    database.close();
});

test("SQLite Store 拒绝 identity 变化、terminal 回退和非法运行时 Span", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "identity" },
        async (turn) => turn.setOutput({ answer: "done" }),
    ));
    const root = store.listBySession(sessionId)[0]!;
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    const variants = [
        { ...root, revision: root.revision + 1, traceId: "changed" },
        { ...root, revision: root.revision + 1, parentSpanId: "changed" },
        { ...root, revision: root.revision + 1, sequence: 2 },
        { ...root, revision: root.revision + 1, name: "agent.step", kind: "STEP" },
        { ...root, revision: root.revision + 1, status: "running", endedAt: undefined },
        { ...root, revision: root.revision + 1, schemaVersion: 3 },
        { ...root, revision: root.revision + 1, name: "toString" },
    ];
    for (const variant of variants) store.upsert(variant as never);
    assert.deepEqual(store.listBySession(sessionId), [root]);
    assert.equal(notifications, 0);
    store.close();
});

test("SQLite Store 提交后通知，并隔离 listener 抛错与修改", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    const observed: Array<{ notifiedRevision: number; storedRevision: number; status: string }> = [];
    store.subscribe((change) => {
        change.span.status = "error";
        throw new Error("listener failure");
    });
    store.subscribe((change) => {
        const stored = store.listByTrace(change.traceId).find((span) => span.spanId === change.span.spanId)!;
        observed.push({
            notifiedRevision: change.span.revision,
            storedRevision: stored.revision,
            status: change.span.status,
        });
    });

    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "listener" },
        async (turn) => turn.setOutput({ answer: "done" }),
    ));
    assert.equal(observed.length, 2);
    assert.equal(observed.every((item) => item.storedRevision >= item.notifiedRevision), true);
    assert.deepEqual(observed.map((item) => item.status), ["running", "ok"]);
    store.close();
});

test("SQLite 外键写入失败通过 Tracer 被动隔离", async () => {
    const { databasePath } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const errors: unknown[] = [];
    const tracer = new Tracer(store, { onWriteError: (error) => errors.push(error) });
    const result = await tracer.withSession("missing-session", () => tracer.trace(
        "agent.turn",
        { userInput: "business" },
        async (turn) => {
            turn.setOutput({ answer: "business-ok" });
            return "business-ok";
        },
    ));
    assert.equal(result, "business-ok");
    assert.equal(errors.length, 1);
    assert.deepEqual(store.listBySession("missing-session"), []);
    store.close();
});
