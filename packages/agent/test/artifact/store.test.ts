import assert from "node:assert/strict";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { InMemoryArtifactStore, type ArtifactMetadata } from "../../src/artifact/index.js";

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
    assert.deepEqual(
        events.map((event) => event.name),
        ["artifact.created", "artifact.resolved"],
    );
    assert.doesNotMatch(JSON.stringify(events), /完整面试原文/);
});

test("Artifact Store 拒绝未知 ID 和错误类型", () => {
    const artifacts = new InMemoryArtifactStore();
    const id = artifacts.put("file_text", "text", { producer: "read_file" });

    assert.throws(() => artifacts.get(id, "parsed_transcript", "structure_interview"), /Artifact 类型不匹配/);
    assert.throws(() => artifacts.get("missing", "file_text", "parse_transcript"), /Artifact 不存在或已过期/);
});

test("Artifact 类型不匹配时 Trace 记录解析失败", () => {
    const traceStore = new MemoryTraceStore();
    const artifacts = new InMemoryArtifactStore(new Tracer(traceStore));
    const id = artifacts.put("file_text", "text", { producer: "read_file" });

    assert.throws(() => artifacts.get(id, "parsed_transcript", "structure_interview"), /Artifact 类型不匹配/);

    const resolved = traceStore.list().find((event) => event.name === "artifact.resolved");
    assert.deepEqual(resolved?.data, {
        artifactId: id,
        artifactType: "parsed_transcript",
        consumer: "structure_interview",
        hit: false,
    });
});

test("Artifact Store 不将额外元数据写入 Trace", () => {
    const traceStore = new MemoryTraceStore();
    const artifacts = new InMemoryArtifactStore(new Tracer(traceStore));
    const traceSecret = "运行时额外字段不得进入 Trace";

    artifacts.put("file_text", "text", {
        producer: "read_file",
        traceSecret,
    } as ArtifactMetadata);

    assert.doesNotMatch(JSON.stringify(traceStore.list()), /运行时额外字段不得进入 Trace/);
});
