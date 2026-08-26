import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryTraceStore, type TraceEvent } from "@dkagent/trace";

import { startTapServer } from "../src/tap/server.js";

const event: TraceEvent = {
    id: "event-1",
    traceId: "turn-1",
    sequence: 1,
    timestamp: "2026-08-12T00:00:00.000Z",
    name: "agent.turn",
    phase: "start",
    data: { input: "你好" },
};

class TrackingStore extends MemoryTraceStore {
    unsubscribeCount = 0;

    override subscribe(listener: (item: TraceEvent) => void | Promise<void>): () => void {
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
    const store = new MemoryTraceStore();
    const server = await startTapServer({ store, webRoot, port: 0 });
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

test("提供只读 Session 列表、详情和对应 Trace", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const store = new MemoryTraceStore();
    store.emit({ ...event, sessionId: "session-1" });
    store.emit({ ...event, id: "event-2", traceId: "turn-2", sessionId: "session-2" });
    const sessions = {
        list: () => [
            {
                id: "session-1",
                createdAt: "2026-08-18T00:00:00.000Z",
                updatedAt: "2026-08-18T00:01:00.000Z",
                preview: "你好",
                messageCount: 2,
                turnCount: 1,
                hasTrace: true,
            },
        ],
        load: (sessionId: string) =>
            sessionId === "session-1"
                ? {
                      id: sessionId,
                      createdAt: "2026-08-18T00:00:00.000Z",
                      updatedAt: "2026-08-18T00:01:00.000Z",
                      messages: [{ role: "user", content: "你好" }],
                      contextSummary: "",
                  }
                : null,
    };
    const server = await startTapServer({ store, sessions, webRoot, port: 0 });
    t.after(() => server.close());

    assert.deepEqual(await fetch(`${server.url}api/sessions`).then((response) => response.json()), sessions.list());
    assert.deepEqual(
        await fetch(`${server.url}api/sessions/session-1`).then((response) => response.json()),
        sessions.load("session-1"),
    );
    assert.equal((await fetch(`${server.url}api/sessions/missing`)).status, 404);
    const events = await fetch(`${server.url}api/sessions/session-1/events`).then(
        (response) => response.json() as Promise<TraceEvent[]>,
    );
    assert.deepEqual(
        events.map((item) => item.id),
        ["event-1"],
    );
});

test("Session 详情前端路由回退首页且缺失静态资源仍为 404", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const server = await startTapServer({ store: new MemoryTraceStore(), webRoot, port: 0 });
    t.after(() => server.close());

    assert.equal(
        await fetch(`${server.url}sessions/session-1`).then((response) => response.text()),
        '<div id="root"></div>',
    );
    assert.equal((await fetch(`${server.url}assets/missing.js`)).status, 404);
});

test("拒绝目录穿越且缺失资源不回退到首页", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const store = new MemoryTraceStore();
    const server = await startTapServer({ store, webRoot, port: 0 });
    t.after(() => server.close());

    // 使用原始 HTTP path，避免 fetch 客户端预先规整 `..` 路径。
    const statusFor = (path: string) =>
        new Promise<number>((resolve, reject) => {
            const serverUrl = new URL(server.url);
            const outgoing = httpRequest(
                {
                    host: serverUrl.hostname,
                    port: serverUrl.port,
                    path,
                },
                (response) => {
                    response.resume();
                    response.once("end", () => resolve(response.statusCode ?? 0));
                },
            );
            outgoing.once("error", reject);
            outgoing.end();
        });

    assert.equal(await statusFor("/../package.json"), 404);
    assert.equal(await statusFor("/%2e%2e/package.json"), 404);
    assert.equal((await fetch(`${server.url}assets/missing.js`)).status, 404);
});

test(
    "拒绝 webRoot 内指向外部文件的符号链接",
    {
        skip: process.platform === "win32" ? "Windows 创建符号链接通常需要额外权限" : false,
    },
    async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
        const webRoot = await createWebRoot(directory);
        const outsideFile = join(directory, "outside.txt");
        await writeFile(outsideFile, "repository secret", "utf8");
        await symlink(outsideFile, join(webRoot, "assets", "outside.txt"));

        const store = new MemoryTraceStore();
        const server = await startTapServer({ store, webRoot, port: 0 });
        t.after(() => server.close());

        assert.equal((await fetch(`${server.url}assets/outside.txt`)).status, 404);
    },
);

test("仅监听 loopback 地址", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const store = new MemoryTraceStore();
    const attempt = startTapServer({ store, webRoot, host: "0.0.0.0", port: 0 });
    try {
        await assert.rejects(attempt, /127\.0\.0\.1/);
    } finally {
        await attempt.then(
            (server) => server.close(),
            () => undefined,
        );
    }
});

test("向 SSE 客户端推送新事件", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const store = new MemoryTraceStore();
    const server = await startTapServer({ store, webRoot, port: 0 });
    t.after(() => server.close());

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}api/events/stream`, {
        signal: controller.signal,
    });
    const reader = streamResponse.body?.getReader();
    assert.ok(reader);

    store.emit(event);
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /"id":"event-1"/);
    controller.abort();
});

test("SSE 与历史 API 返回一致的脱敏事件", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const store = new MemoryTraceStore();
    const server = await startTapServer({ store, webRoot, port: 0 });
    t.after(() => server.close());

    const controller = new AbortController();
    const streamResponse = await fetch(`${server.url}api/events/stream`, {
        signal: controller.signal,
    });
    const reader = streamResponse.body?.getReader();
    assert.ok(reader);

    const secrets = ["sse-api-key", "sse-authorization", "sse-header", "sse-env"];
    store.emit({
        ...event,
        id: "event-secret",
        data: {
            apiKey: secrets[0],
            authorization: secrets[1],
            headers: { authorization: secrets[2] },
            env: { OPENAI_API_KEY: secrets[3] },
        },
    });

    const chunk = new TextDecoder().decode((await reader.read()).value);
    for (const secret of secrets) assert.doesNotMatch(chunk, new RegExp(secret));
    const liveEvent = JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] ?? "null") as TraceEvent;
    const history = await fetch(`${server.url}api/events`).then((response) => response.json() as Promise<TraceEvent[]>);
    assert.deepEqual(liveEvent, history[0]);
    assert.equal(liveEvent.sequence, event.sequence);
    controller.abort();
});

test("监听端口失败时取消 Tap 订阅", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const webRoot = await createWebRoot(directory);
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    t.after(
        () => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))),
    );
    const { port } = occupied.address() as AddressInfo;
    const store = new TrackingStore();

    await assert.rejects(startTapServer({ store, webRoot, port }));
    assert.equal(store.unsubscribeCount, 1);
});

test("Web 根目录不可读时拒绝启动并取消 Tap 订阅", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
    const store = new TrackingStore();

    await assert.rejects(startTapServer({ store, webRoot: join(directory, "missing-dist"), port: 0 }));
    assert.equal(store.unsubscribeCount, 1);
});
