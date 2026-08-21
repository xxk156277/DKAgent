import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";

test("Artifact Store 按类型读写且 Trace 不包含正文", () => {
    const traceStore = new MemoryTraceStore();
    const artifacts = new InMemoryArtifactStore(new Tracer(traceStore));
    const secret = "完整面试原文不得进入 Trace";
    const id = artifacts.put("file_text", secret, {
        producer: "read_file",
        characterCount: secret.length,
        itemCount: 1,
        exposedCharacterCount: 120,
    });

    assert.equal(artifacts.get(id, "file_text", "parse_transcript"), secret);
    const events = traceStore.list().filter((event) => event.name.startsWith("artifact."));
    assert.deepEqual(events.map((event) => event.name), [
        "artifact.created",
        "artifact.resolved",
    ]);
    assert.doesNotMatch(JSON.stringify(events), /完整面试原文/);
});

test("Artifact Store 拒绝未知 ID 和错误类型", () => {
    const artifacts = new InMemoryArtifactStore();
    const id = artifacts.put("file_text", "text", { producer: "read_file" });

    assert.throws(
        () => artifacts.get(id, "parsed_transcript", "structure_interview"),
        /Artifact 类型不匹配/,
    );
    assert.throws(
        () => artifacts.get("missing", "file_text", "parse_transcript"),
        /Artifact 不存在或已过期/,
    );
});
