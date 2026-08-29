import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { ArtifactAccessError, InMemoryArtifactStore, type ArtifactMetadata } from "../../src/artifact/index.js";

test("Artifact put/get 在 active Trace 中形成 typed parent-child spans且不记录正文", async () => {
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    const secret = "完整面试原文不得进入 Trace";
    let id = "";
    await tracer.trace("agent.turn", { userInput: "读取 artifact" }, async (turn) => {
        id = artifacts.put("file_text", secret, { producer: "read_file", characterCount: secret.length, itemCount: 1, exposedCharacterCount: 120 });
        assert.equal(artifacts.get(id, "file_text", "parse_transcript"), secret);
        turn.setOutput({ answer: "完成" });
    });
    const spans = traceStore.list();
    assert.deepEqual(spans.map((span) => span.name), ["agent.turn", "artifact.put", "artifact.get"]);
    assert.equal(spans[1]?.parentSpanId, spans[0]?.spanId);
    assert.equal(spans[2]?.parentSpanId, spans[0]?.spanId);
    assert.deepEqual(spans[1]?.input, { kind: "file_text", metadata: { producer: "read_file", characterCount: secret.length, itemCount: 1, exposedCharacterCount: 120 } });
    assert.deepEqual(spans[1]?.output, { artifactId: id });
    assert.deepEqual(spans[2]?.input, { artifactId: id, expectedKind: "file_text", consumer: "parse_transcript" });
    assert.deepEqual(spans[2]?.output, { hit: true });
    assert.equal(spans[1]?.status, "ok");
    assert.equal(spans[2]?.status, "ok");
    assert.equal(typeof spans[1]?.durationMs, "number");
    assert.equal(typeof spans[2]?.durationMs, "number");
    assert.doesNotMatch(JSON.stringify(spans), /完整面试原文/);
});

test("Artifact missing/type mismatch 先记录 hit=false 再原样抛错", async () => {
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    await assert.rejects(tracer.trace("agent.turn", { userInput: "读取 artifact" }, async () => {
        assert.throws(() => artifacts.get("missing", "file_text", "reader"), (error: unknown) => error instanceof ArtifactAccessError);
        const id = artifacts.put("file_text", "正文", { producer: "read_file" });
        assert.throws(() => artifacts.get(id, "parsed_transcript", "reader"), (error: unknown) => error instanceof ArtifactAccessError);
        throw new Error("business failure");
    }), /business failure/);
    const gets = traceStore.list().filter((span) => span.name === "artifact.get");
    assert.equal(gets.length, 2);
    assert.deepEqual(gets.map((span) => span.output), [{ hit: false }, { hit: false }]);
    assert.deepEqual(gets.map((span) => span.status), ["error", "error"]);
});

test("Artifact metadata 仅写入白名单，额外字段和正文不入 Trace", async () => {
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    const traceSecret = "运行时额外字段不得进入 Trace";
    await tracer.trace("agent.turn", { userInput: "保存" }, async (turn) => {
        artifacts.put("file_text", traceSecret, { producer: "read_file", traceSecret } as ArtifactMetadata);
        turn.setOutput({ answer: "完成" });
    });
    const put = traceStore.list().find((span) => span.name === "artifact.put");
    assert.deepEqual(put?.input, { kind: "file_text", metadata: { producer: "read_file" } });
    assert.doesNotMatch(JSON.stringify(traceStore.list()), /运行时额外字段不得进入 Trace/);
});

test("Artifact 无 active Trace 时保持同步业务 API", () => {
    const store = new MemoryTraceStore();
    const artifacts = new InMemoryArtifactStore(new Tracer(store));
    const value = { content: "正文" };
    const id = artifacts.put("file_text", value, { producer: "read_file" });
    assert.equal(typeof id, "string");
    assert.equal(artifacts.get(id, "file_text", "reader"), value);
    assert.deepEqual(store.list(), []);
});

test("Artifact sink 失败不影响同步存取", async () => {
    const writes: unknown[] = [];
    const tracer = new Tracer({ upsert: () => { throw new Error("sink down"); } }, { onWriteError: (error) => writes.push(error) });
    const artifacts = new InMemoryArtifactStore(tracer);
    await tracer.trace("agent.turn", { userInput: "保存" }, async (turn) => {
        const id = artifacts.put("file_text", "正文", { producer: "read_file" });
        assert.equal(artifacts.get(id, "file_text", "reader"), "正文");
        turn.setOutput({ answer: "完成" });
    });
    assert.ok(writes.length > 0);
});

test("Artifact hostile metadata 在 active/no-active 下都不阻止 put，active Trace 降级完整性", async () => {
    const hostile = { get producer(): string { throw new Error("metadata getter"); } } as unknown as ArtifactMetadata;
    const noActive = new InMemoryArtifactStore();
    const value = { body: "正文" };
    const noActiveId = noActive.put("file_text", value, hostile);
    assert.equal(noActive.get(noActiveId, "file_text", "reader"), value);

    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const active = new InMemoryArtifactStore(tracer);
    let id = "";
    await tracer.trace("agent.turn", { userInput: "保存" }, async (turn) => {
        id = active.put("file_text", value, new Proxy({}, {
            get() { throw new Error("proxy metadata getter"); },
            ownKeys() { throw new Error("proxy metadata keys"); },
        }) as ArtifactMetadata);
        assert.equal(active.get(id, "file_text", "reader"), value);
        turn.setOutput({ answer: "完成" });
    });
    assert.equal(active.get(id, "file_text", "reader"), value);
    const put = traceStore.list().find((span) => span.name === "artifact.put");
    assert.equal(put?.status, "ok");
    assert.equal(put?.integrity, false);
    assert.ok((put?.durationMs ?? 0) >= 0);
    assert.doesNotMatch(JSON.stringify(traceStore.list()), /proxy metadata|metadata getter/);
});

test("Artifact null/undefined/PromiseLike value 只读取一次且不触发 spanSync 异步判定", async () => {
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    const reads = { producer: 0, characterCount: 0, itemCount: 0, exposedCharacterCount: 0 };
    const value = { then: () => undefined };
    await tracer.trace("agent.turn", { userInput: "保存" }, async (turn) => {
        const id = artifacts.put("file_text", value, {
            get producer() { reads.producer += 1; return "reader"; },
            get characterCount() { reads.characterCount += 1; return 1; },
            get itemCount() { reads.itemCount += 1; return 1; },
            get exposedCharacterCount() { reads.exposedCharacterCount += 1; return 1; },
        });
        assert.equal(artifacts.get(id, "file_text", "reader"), value);
        const nullId = artifacts.put("file_text", null, { producer: "reader" });
        assert.equal(artifacts.get(nullId, "file_text", "reader"), null);
        const undefinedId = artifacts.put("file_text", undefined, { producer: "reader" });
        assert.equal(artifacts.get(undefinedId, "file_text", "reader"), undefined);
        turn.setOutput({ answer: "完成" });
    });
    assert.deepEqual(reads, { producer: 1, characterCount: 1, itemCount: 1, exposedCharacterCount: 1 });
});
