import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { SqliteTraceStore, Tracer } from "../src/index.js";

function createSessionDatabase(): { databasePath: string; sessionId: string } {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-trace-document-"));
    const databasePath = join(directory, "sessions.db");
    const sessionId = "session-document";
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
        INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)
    `).run(sessionId, "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    database.close();
    return { databasePath, sessionId };
}

async function writeCompletedTrace(
    store: SqliteTraceStore,
    sessionId: string,
    userInput: string,
): Promise<string> {
    const tracer = new Tracer(store);
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput },
        async (turn) => {
            await tracer.span("model.generate", {
                provider: "fake", model: "fake", messages: [{ role: "user", content: userInput }],
            }, async (model) => {
                model.setTokenUsage({ inputTokens: 10, outputTokens: 2 });
                model.setOutput({ type: "text", content: "done", stopReason: "end_turn" });
            });
            turn.setOutput({ answer: "done" });
        },
    ));
    return store.listBySession(sessionId).find((span) => (
        span.name === "agent.turn" && span.input.userInput === userInput
    ))!.traceId;
}

test("recent 与 TraceDocument 在重启后返回有界摘要和 canonical Span", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const firstStore = new SqliteTraceStore(databasePath);
    const firstTraceId = await writeCompletedTrace(firstStore, sessionId, "first");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondTraceId = await writeCompletedTrace(firstStore, sessionId, "second");
    firstStore.close();

    const secondStore = new SqliteTraceStore(databasePath);
    const recent = secondStore.recent();
    assert.deepEqual(recent.map((trace) => trace.traceId), [secondTraceId, firstTraceId]);
    assert.deepEqual(recent.map((trace) => trace.spanCount), [2, 2]);
    assert.equal(recent.every((trace) => trace.status === "ok" && trace.integrity), true);
    assert.throws(() => secondStore.recent(101), /1～100/);

    const document = secondStore.getTraceDocument(firstTraceId)!;
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.trace.traceId, firstTraceId);
    assert.equal(document.trace.sessionId, sessionId);
    assert.equal(document.trace.spanCount, 2);
    assert.equal(document.complete, true);
    assert.deepEqual(document.diagnostics, {
        missingRoot: false,
        missingParent: [],
        running: [],
        outputMissing: [],
        serializationError: [],
    });
    assert.deepEqual(document.spans.map((span) => span.sequence), [1, 2]);
    assert.deepEqual(document.spans[1]?.tokenUsage, { inputTokens: 10, outputTokens: 2 });
    assert.equal(secondStore.getTraceDocument("missing"), null);
    secondStore.close();
});

test("按 Session 倒序读取有界 TraceSummary，并判断 Session 是否有 Trace", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const firstTraceId = await writeCompletedTrace(store, sessionId, "first");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const secondTraceId = await writeCompletedTrace(store, sessionId, "second");

    assert.deepEqual(
        store.listTraceSummariesBySession(sessionId, 1).map((trace) => trace.traceId),
        [secondTraceId],
    );
    assert.equal(store.hasTraceForSession(sessionId), true);
    assert.deepEqual(store.listTraceSummariesBySession("missing", 100), []);
    assert.equal(store.hasTraceForSession("missing"), false);
    assert.throws(() => store.listTraceSummariesBySession(sessionId, 101), /1～100/);
    assert.notEqual(firstTraceId, secondTraceId);
    store.close();
});

test("TraceDocument 报告 running、缺父、缺输出和序列化降级", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "incomplete" },
        async () => tracer.span("tool.execute", {
            toolCallId: "call", name: "tool", input: {},
        }, async (tool) => {
            tool.event("context.tokens.counted", circular as never);
            tool.setOutput({ success: true });
        }),
    ));
    const spans = store.listBySession(sessionId);
    const root = spans.find((span) => span.name === "agent.turn")!;
    const child = spans.find((span) => span.name === "tool.execute")!;

    const database = new Database(databasePath);
    database.prepare(`
        UPDATE trace_spans
        SET parent_span_id = ?, status = 'running', ended_at = NULL, duration_ms = NULL
        WHERE span_id = ?
    `).run("missing-parent", child.spanId);
    database.close();

    const document = store.getTraceDocument(root.traceId)!;
    assert.equal(document.complete, false);
    assert.deepEqual(document.diagnostics.missingParent, [child.spanId]);
    assert.deepEqual(document.diagnostics.running, [child.spanId]);
    assert.deepEqual(document.diagnostics.outputMissing, [root.spanId]);
    assert.deepEqual(document.diagnostics.serializationError, [child.spanId]);
    store.close();
});

test("TraceDocument 报告缺根并拒绝未知磁盘 schema", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const traceId = await writeCompletedTrace(store, sessionId, "corrupt");
    const root = store.listByTrace(traceId)[0]!;

    const database = new Database(databasePath);
    database.prepare("DELETE FROM trace_spans WHERE span_id = ?").run(root.spanId);
    database.close();
    const missingRoot = store.getTraceDocument(traceId)!;
    assert.equal(missingRoot.complete, false);
    assert.equal(missingRoot.diagnostics.missingRoot, true);

    const remaining = store.listByTrace(traceId)[0]!;
    const corruptDatabase = new Database(databasePath);
    corruptDatabase.prepare("UPDATE trace_spans SET schema_version = 3 WHERE span_id = ?").run(remaining.spanId);
    corruptDatabase.close();
    assert.throws(() => store.getTraceDocument(traceId), /不支持/);
    store.close();
});

test("TraceDocument 可完整读取超过 100 个 Span", async () => {
    const { databasePath, sessionId } = createSessionDatabase();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    await tracer.withSession(sessionId, () => tracer.trace(
        "agent.turn",
        { userInput: "many" },
        async (turn) => {
            for (let step = 1; step <= 101; step += 1) {
                await tracer.span("agent.step", { step }, async (span) => {
                    span.setOutput({ outcome: "answer", stopReason: "end_turn", toolCallCount: 0 });
                });
            }
            turn.setOutput({ answer: "done" });
        },
    ));
    const traceId = store.listBySession(sessionId, 1000)[0]!.traceId;
    const document = store.getTraceDocument(traceId)!;
    assert.equal(document.spans.length, 102);
    assert.equal(document.trace.spanCount, 102);
    assert.equal(document.complete, true);
    store.close();
});
