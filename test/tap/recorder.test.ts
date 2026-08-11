import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TapRecorder } from "../../src/tap/recorder.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";

const event: RuntimeEvent = {
  id: "event-1",
  sessionId: "session-1",
  turnId: "turn-1",
  sequence: 1,
  timestamp: "2026-08-11T00:00:00.000Z",
  type: "turn.start",
  payload: { input: "你好" },
};

test("按顺序写入 JSONL 并通知订阅者", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const filePath = join(directory, "trace.jsonl");
  const recorder = new TapRecorder(filePath);
  const received: RuntimeEvent[] = [];
  recorder.subscribe((item) => received.push(item));

  recorder.emit(event);
  recorder.emit({ ...event, id: "event-2", sequence: 2, type: "turn.end" });
  await recorder.flush();

  assert.deepEqual(received.map((item) => item.sequence), [1, 2]);
  assert.deepEqual((await recorder.readEvents()).map((item) => item.sequence), [1, 2]);
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2);
});

test("写入失败会被隔离并发出警告", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const parentFile = join(directory, "parent-file");
  const warnings: string[] = [];
  await writeFile(parentFile, "not a directory");
  const recorder = new TapRecorder(join(parentFile, "trace.jsonl"), (message) => warnings.push(message));

  recorder.emit(event);
  await assert.doesNotReject(recorder.flush());
  assert.equal(warnings.length, 1);
});

test("循环 payload 会记录序列化错误", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const filePath = join(directory, "trace.jsonl");
  const recorder = new TapRecorder(filePath);
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  recorder.emit({ ...event, id: "event-circular", payload: circular });
  await recorder.flush();

  const saved = await recorder.readEvents();
  assert.equal(typeof (saved.at(-1)?.payload as { serializationError: string }).serializationError, "string");
});
