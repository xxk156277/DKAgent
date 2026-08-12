import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { TapRecorder } from "../src/tap/recorder.js";

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
  recorder.subscribe((item) => {
    received.push(item);
  });

  recorder.emit(event);
  recorder.emit({ ...event, id: "event-2", sequence: 2, type: "turn.end" });
  await recorder.flush();

  assert.deepEqual(received.map((item) => item.sequence), [1, 2]);
  assert.deepEqual((await recorder.readEvents()).map((item) => item.sequence), [1, 2]);
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2);
});

test("读取事件会等待已经入队的写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));

  recorder.emit(event);

  assert.deepEqual((await recorder.readEvents()).map((item) => item.id), [event.id]);
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

test("敏感字段会在写入 JSONL 前脱敏", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const filePath = join(directory, "trace.jsonl");
  const recorder = new TapRecorder(filePath);
  const secrets = [
    "secret-api-key-value",
    "secret-authorization-value",
    "secret-header-value",
    "secret-env-value",
    "secret-environment-value",
  ];

  recorder.emit({
    ...event,
    payload: {
      apiKey: secrets[0],
      nested: {
        authorization: secrets[1],
        headers: { "x-api-key": secrets[2] },
        env: { OPENAI_API_KEY: secrets[3] },
        environment: secrets[4],
      },
    },
  });
  await recorder.flush();

  const content = await readFile(filePath, "utf8");
  for (const secret of secrets) assert.doesNotMatch(content, new RegExp(secret));
  const saved = (await recorder.readEvents())[0]?.payload as {
    apiKey: string;
    nested: Record<string, string>;
  };
  assert.equal(saved.apiKey, "[REDACTED]");
  assert.equal(saved.nested.authorization, "[REDACTED]");
  assert.equal(saved.nested.headers, "[REDACTED]");
  assert.equal(saved.nested.env, "[REDACTED]");
  assert.equal(saved.nested.environment, "[REDACTED]");
});

test("异步订阅者拒绝不会产生未处理拒绝或阻断写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const filePath = join(directory, "trace.jsonl");
  const recorder = new TapRecorder(filePath);
  recorder.subscribe(async () => {
    throw new Error("listener rejected");
  });

  recorder.emit(event);
  await recorder.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual((await recorder.readEvents()).map((item) => item.id), [event.id]);
});

test("告警回调抛错后后续事件仍可写入", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-"));
  const parentFile = join(directory, "parent-file");
  await writeFile(parentFile, "not a directory");
  const recorder = new TapRecorder(join(parentFile, "trace.jsonl"), () => {
    throw new Error("warning failed");
  });

  recorder.emit(event);
  await assert.doesNotReject(recorder.flush());
  await unlink(parentFile);
  recorder.emit({ ...event, id: "event-2", sequence: 2, type: "turn.end" });
  await recorder.flush();

  assert.deepEqual((await recorder.readEvents()).map((item) => item.sequence), [2]);
});
