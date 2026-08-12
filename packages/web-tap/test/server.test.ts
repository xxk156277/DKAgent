import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { TapRecorder } from "../src/tap/recorder.js";
import { startTapServer } from "../src/tap/server.js";

const event: RuntimeEvent = {
  id: "event-1",
  sessionId: "session-1",
  turnId: "turn-1",
  sequence: 1,
  timestamp: "2026-08-12T00:00:00.000Z",
  type: "turn.start",
  payload: { input: "你好" },
};

class TrackingRecorder extends TapRecorder {
  unsubscribeCount = 0;

  override subscribe(listener: (item: RuntimeEvent) => void | Promise<void>): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.unsubscribeCount += 1;
      unsubscribe();
    };
  }
}

async function createWebRoot(directory: string): Promise<string> {
  const webRoot = join(directory, "dist");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), '<div id="root"></div>', "utf8");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('tap');", "utf8");
  return webRoot;
}

test("提供 Vite 首页、静态资源、历史事件和 SSE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, webRoot, port: 0 });
  t.after(() => server.close());

  const rootResponse = await fetch(server.url);
  assert.equal(rootResponse.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await rootResponse.text(), '<div id="root"></div>');

  const scriptResponse = await fetch(`${server.url}assets/app.js`);
  assert.equal(scriptResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await scriptResponse.text(), "console.log('tap');");

  const events = await fetch(`${server.url}api/events`).then((response) => response.json());
  assert.deepEqual(events, []);

  const controller = new AbortController();
  const streamResponse = await fetch(`${server.url}api/events/stream`, {
    signal: controller.signal,
  });
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
  controller.abort();
});

test("拒绝目录穿越且缺失资源不回退到首页", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, webRoot, port: 0 });
  t.after(() => server.close());

  // 使用原始 HTTP path，避免 fetch 客户端预先规整 `..` 路径。
  const statusFor = (path: string) => new Promise<number>((resolve, reject) => {
    const serverUrl = new URL(server.url);
    const outgoing = httpRequest({
      host: serverUrl.hostname,
      port: serverUrl.port,
      path,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

  assert.equal(await statusFor("/../package.json"), 404);
  assert.equal(await statusFor("/%2e%2e/package.json"), 404);
  assert.equal((await fetch(`${server.url}assets/missing.js`)).status, 404);
});

test("仅监听 loopback 地址", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const attempt = startTapServer({ recorder, webRoot, host: "0.0.0.0", port: 0 });
  try {
    await assert.rejects(attempt, /127\.0\.0\.1/);
  } finally {
    await attempt.then((server) => server.close(), () => undefined);
  }
});

test("向 SSE 客户端推送新事件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, webRoot, port: 0 });
  t.after(() => server.close());

  const controller = new AbortController();
  const streamResponse = await fetch(`${server.url}api/events/stream`, {
    signal: controller.signal,
  });
  const reader = streamResponse.body?.getReader();
  assert.ok(reader);

  recorder.emit(event);
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /"id":"event-1"/);
  controller.abort();
});

test("监听端口失败时取消 Tap 订阅", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))));
  const { port } = occupied.address() as AddressInfo;
  const recorder = new TrackingRecorder(join(directory, "trace.jsonl"));

  await assert.rejects(startTapServer({ recorder, webRoot, port }));
  assert.equal(recorder.unsubscribeCount, 1);
});

test("Web 根目录不可读时拒绝启动并取消 Tap 订阅", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const recorder = new TrackingRecorder(join(directory, "trace.jsonl"));

  await assert.rejects(
    startTapServer({ recorder, webRoot: join(directory, "missing-dist"), port: 0 }),
  );
  assert.equal(recorder.unsubscribeCount, 1);
});
