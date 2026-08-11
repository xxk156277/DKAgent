import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TapRecorder } from "../../src/tap/recorder.js";
import { startTapServer } from "../../src/tap/server.js";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { VIEWER_HTML } from "../../src/tap/viewer.js";

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

test("提供 Viewer、历史事件和 SSE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, port: 0 });
  t.after(() => server.close());

  const html = await fetch(server.url).then((response) => response.text());
  assert.match(html, /DKAgent Tap/);
  assert.match(html, /context\.after/);

  const events = await fetch(`${server.url}api/events`).then((response) => response.json());
  assert.deepEqual(events, []);

  const controller = new AbortController();
  const streamResponse = await fetch(`${server.url}api/events/stream`, {
    signal: controller.signal,
  });
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
  controller.abort();
});

test("仅监听 loopback 地址", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const attempt = startTapServer({ recorder, host: "0.0.0.0", port: 0 });
  try {
    await assert.rejects(attempt, /127\.0\.0\.1/);
  } finally {
    await attempt.then((server) => server.close(), () => undefined);
  }
});

test("向 SSE 客户端推送新事件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, port: 0 });
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
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))));
  const { port } = occupied.address() as AddressInfo;
  const recorder = new TrackingRecorder(join(directory, "trace.jsonl"));

  await assert.rejects(startTapServer({ recorder, port }));
  assert.equal(recorder.unsubscribeCount, 1);
});

test("Viewer 转义动态内容且客户端脚本可独立启动", async () => {
  assert.match(VIEWER_HTML, /<small> step ' \+ escapeHtml\(event\.step \?\? '-'\)/);
  assert.match(VIEWER_HTML, /const remaining = new Map\(\)/);
  assert.doesNotMatch(VIEWER_HTML, /__name/);

  const script = VIEWER_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  const nodes = new Map<string, { innerHTML: string; textContent: string }>();
  const document = {
    addEventListener: () => undefined,
    querySelector: (selector: string) => {
      let node = nodes.get(selector);
      if (!node) {
        node = { innerHTML: "", textContent: "" };
        nodes.set(selector, node);
      }
      return node;
    },
  };
  let stream: {
    onopen?(): void;
    onmessage?(message: { data: string }): void;
    onerror?(): void;
  } | undefined;
  class FakeEventSource {
    constructor(_url: string) {
      stream = this;
    }
  }
  const runViewer = new Function("document", "EventSource", "fetch", script);
  runViewer(
    document,
    FakeEventSource,
    async () => ({ json: async () => [event] }),
  );

  stream?.onopen?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(nodes.get("#status")?.textContent, "实时连接");
  assert.match(nodes.get("#flow")?.innerHTML ?? "", /event-1/);
});
