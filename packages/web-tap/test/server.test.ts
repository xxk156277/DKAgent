import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createTraceDocument,
  MemoryTraceStore,
  type AnyTraceSpan,
  type TraceDocument,
  type TraceListener,
  type TraceReader,
  type TraceSummary,
} from "@dkagent/trace";
import { startTapServer } from "../src/tap/server.js";

const rootSpan: AnyTraceSpan = {
  schemaVersion: 2,
  traceId: "trace-1",
  spanId: "span-1",
  sessionId: "session-1",
  name: "agent.turn",
  kind: "AGENT",
  status: "ok",
  sequence: 1,
  revision: 2,
  startedAt: "2026-08-12T00:00:00.000Z",
  endedAt: "2026-08-12T00:00:00.010Z",
  durationMs: 10,
  input: { userInput: "你好" },
  output: { answer: "你好" },
  tokenUsage: null,
  attributes: {},
  events: [],
  integrity: true,
};

class ReaderStore extends MemoryTraceStore implements TraceReader {
  unsubscribeCount = 0;
  failReads = false;

  override subscribe(listener: TraceListener): () => void {
    const unsubscribe = super.subscribe(listener);
    return () => {
      this.unsubscribeCount += 1;
      unsubscribe();
    };
  }

  listTraceSummariesBySession(sessionId: string, limit = 100): TraceSummary[] {
    if (this.failReads) throw new Error("database secret");
    return this.summaries().filter((trace) => trace.sessionId === sessionId).slice(0, limit);
  }

  getTraceDocument(traceId: string): TraceDocument | null {
    if (this.failReads) throw new Error("database secret");
    const trace = this.summaries().find((item) => item.traceId === traceId);
    return trace ? createTraceDocument(trace, this.listByTrace(traceId, 1000)) : null;
  }

  hasTraceForSession(sessionId: string): boolean {
    return this.summaries().some((trace) => trace.sessionId === sessionId);
  }

  private summaries(): TraceSummary[] {
    return this.list(1000)
      .filter((span) => span.name === "agent.turn")
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((span) => ({
        traceId: span.traceId,
        ...(span.sessionId === undefined ? {} : { sessionId: span.sessionId }),
        status: span.status,
        startedAt: span.startedAt,
        ...(span.endedAt === undefined ? {} : { endedAt: span.endedAt }),
        ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
        spanCount: this.listByTrace(span.traceId, 1000).length,
        integrity: span.integrity,
      }));
  }
}

async function createWebRoot(directory: string): Promise<string> {
  const webRoot = join(directory, "dist");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), '<div id="root"></div>', "utf8");
  await writeFile(join(webRoot, "assets", "app.js"), "console.log('tap');", "utf8");
  return webRoot;
}

test("提供静态资源和 canonical Trace V2 API，旧 Event API 返回 404", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const store = new ReaderStore();
  store.upsert(rootSpan);
  const server = await startTapServer({ store, webRoot, port: 0 });
  t.after(() => server.close());

  assert.equal(await fetch(server.url).then((response) => response.text()), '<div id="root"></div>');
  assert.equal(await fetch(`${server.url}assets/app.js`).then((response) => response.text()), "console.log('tap');");
  const summaries = await fetch(`${server.url}api/sessions/session-1/traces`).then((response) => response.json()) as TraceSummary[];
  assert.deepEqual(summaries.map((trace) => trace.traceId), [rootSpan.traceId]);
  const document = await fetch(`${server.url}api/traces/trace-1`).then((response) => response.json()) as TraceDocument;
  assert.deepEqual(document.spans, [rootSpan]);
  assert.equal(document.complete, true);
  for (const path of ["api/events", "api/events/stream", "api/sessions/session-1/events"]) {
    assert.equal((await fetch(`${server.url}${path}`)).status, 404);
  }
});

test("Trace 不存在返回 404，Reader 损坏返回不泄露细节的 500", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const store = new ReaderStore();
  const server = await startTapServer({ store, webRoot, port: 0 });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}api/traces/missing`)).status, 404);
  store.failReads = true;
  const response = await fetch(`${server.url}api/traces/corrupt`);
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("database secret"), false);
});

test("提供只读 Session 列表和详情", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const store = new ReaderStore();
  const sessions = {
    list: () => [{ id: "session-1", createdAt: "c", updatedAt: "u", preview: "你好", messageCount: 2, turnCount: 1, hasTrace: true }],
    load: (sessionId: string) => sessionId === "session-1"
      ? { id: sessionId, createdAt: "c", updatedAt: "u", messages: [], contextSummary: "" }
      : null,
  };
  const server = await startTapServer({ store, sessions, webRoot, port: 0 });
  t.after(() => server.close());
  assert.deepEqual(await fetch(`${server.url}api/sessions`).then((response) => response.json()), sessions.list());
  assert.deepEqual(await fetch(`${server.url}api/sessions/session-1`).then((response) => response.json()), sessions.load("session-1"));
  assert.equal((await fetch(`${server.url}api/sessions/missing`)).status, 404);
});

test("SSE 仅推送 Store 已接受的 SpanChange", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const store = new ReaderStore();
  const server = await startTapServer({ store, webRoot, port: 0 });
  t.after(() => server.close());
  const controller = new AbortController();
  const streamResponse = await fetch(`${server.url}api/traces/stream`, { signal: controller.signal });
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
  const reader = streamResponse.body?.getReader();
  assert.ok(reader);
  store.upsert(rootSpan);
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /"type":"span_ended"/);
  assert.match(chunk, /"spanId":"span-1"/);
  controller.abort();
});

test("Session 详情前端路由回退首页且缺失静态资源仍为 404", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const server = await startTapServer({ store: new ReaderStore(), webRoot, port: 0 });
  t.after(() => server.close());
  assert.equal(await fetch(`${server.url}sessions/session-1`).then((response) => response.text()), '<div id="root"></div>');
  assert.equal((await fetch(`${server.url}assets/missing.js`)).status, 404);
});

test("拒绝目录穿越且缺失资源不回退到首页", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const server = await startTapServer({ store: new ReaderStore(), webRoot, port: 0 });
  t.after(() => server.close());
  const statusFor = (path: string) => new Promise<number>((resolve, reject) => {
    const serverUrl = new URL(server.url);
    const outgoing = httpRequest({ host: serverUrl.hostname, port: serverUrl.port, path }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
  assert.equal(await statusFor("/../package.json"), 404);
  assert.equal(await statusFor("/%2e%2e/package.json"), 404);
});

test("拒绝 webRoot 内指向外部文件的符号链接", {
  skip: process.platform === "win32" ? "Windows 创建符号链接通常需要额外权限" : false,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const outsideFile = join(directory, "outside.txt");
  await writeFile(outsideFile, "repository secret", "utf8");
  await symlink(outsideFile, join(webRoot, "assets", "outside.txt"));
  const server = await startTapServer({ store: new ReaderStore(), webRoot, port: 0 });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}assets/outside.txt`)).status, 404);
});

test("仅监听 loopback 地址", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  await assert.rejects(startTapServer({ store: new ReaderStore(), webRoot, host: "0.0.0.0", port: 0 }), /127\.0\.0\.1/);
});

test("启动失败时取消 Tap 订阅", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const webRoot = await createWebRoot(directory);
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve())));
  const { port } = occupied.address() as AddressInfo;
  const store = new ReaderStore();
  await assert.rejects(startTapServer({ store, webRoot, port }));
  assert.equal(store.unsubscribeCount, 1);
});

test("Web 根目录不可读时拒绝启动并取消 Tap 订阅", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const store = new ReaderStore();
  await assert.rejects(startTapServer({ store, webRoot: join(directory, "missing-dist"), port: 0 }));
  assert.equal(store.unsubscribeCount, 1);
});
