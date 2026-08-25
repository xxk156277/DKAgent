import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runTraceCli } from "../src/cli.js";
import { SqliteTraceStore, Tracer, type TraceDocument } from "../src/index.js";

async function createTraceDatabase(): Promise<{ databasePath: string; traceId: string }> {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-trace-cli-"));
    const databasePath = join(directory, "sessions.db");
    const database = new Database(databasePath);
    database.exec(`
        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            summary TEXT NOT NULL DEFAULT '',
            first_kept_message_index INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO sessions (id, created_at, updated_at)
        VALUES ('session-cli', '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z');
    `);
    database.close();
    const store = new SqliteTraceStore(databasePath);
    const tracer = new Tracer(store);
    await tracer.withSession("session-cli", () => tracer.trace(
        "agent.turn",
        { userInput: "cli" },
        async (turn) => {
            await tracer.span("model.generate", {
                provider: "fake", model: "fake", messages: [],
            }, async (model) => {
                model.setTokenUsage({ inputTokens: 7, outputTokens: 3 });
                model.setOutput({ type: "text", content: "done", stopReason: "end_turn" });
            });
            turn.setOutput({ answer: "done" });
        },
    ));
    const traceId = store.recent()[0]!.traceId;
    store.close();
    return { databasePath, traceId };
}

function capture(): {
    stdout: string[];
    stderr: string[];
    writeStdout: (text: string) => void;
    writeStderr: (text: string) => void;
} {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
        stdout,
        stderr,
        writeStdout: (text) => stdout.push(text),
        writeStderr: (text) => stderr.push(text),
    };
}

test("trace recent 和 show 文本使用有界只读命令", async () => {
    const { databasePath, traceId } = await createTraceDatabase();
    const recentOutput = capture();
    assert.equal(runTraceCli(["recent"], {
        databasePath, stdout: recentOutput.writeStdout, stderr: recentOutput.writeStderr,
    }), 0);
    assert.match(recentOutput.stdout.join(""), new RegExp(traceId));
    assert.match(recentOutput.stdout.join(""), /spans=2/);
    assert.deepEqual(recentOutput.stderr, []);

    const showOutput = capture();
    assert.equal(runTraceCli(["show", traceId], {
        databasePath, stdout: showOutput.writeStdout, stderr: showOutput.writeStderr,
    }), 0);
    assert.match(showOutput.stdout.join(""), /agent\.turn/);
    assert.match(showOutput.stdout.join(""), /model\.generate/);
    assert.match(showOutput.stdout.join(""), /tokens=7\/3/);
});

test("trace show --json 的 stdout 只包含 canonical TraceDocument", async () => {
    const { databasePath, traceId } = await createTraceDatabase();
    const output = capture();
    assert.equal(runTraceCli(["show", traceId, "--json"], {
        databasePath, stdout: output.writeStdout, stderr: output.writeStderr,
    }), 0);
    const document = JSON.parse(output.stdout.join("")) as TraceDocument;
    assert.equal(document.schemaVersion, 2);
    assert.equal(document.trace.traceId, traceId);
    assert.deepEqual(document.spans.map((span) => span.sequence), [1, 2]);
    assert.deepEqual(output.stderr, []);
});

test("trace CLI 对不存在 Trace、非法命令和参数返回非零", async () => {
    const { databasePath } = await createTraceDatabase();
    for (const args of [["show", "missing"], ["show"], ["recent", "extra"], ["sql", "SELECT 1"]]) {
        const output = capture();
        assert.equal(runTraceCli(args, {
            databasePath, stdout: output.writeStdout, stderr: output.writeStderr,
        }), 1);
        assert.equal(output.stdout.length, 0);
        assert.match(output.stderr.join(""), /Trace|用法/);
    }
});
