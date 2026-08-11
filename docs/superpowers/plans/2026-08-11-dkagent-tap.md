# DKAgent Tap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个本地、只读、模型无关的 DKAgent 运行观测界面，实时展示对话、Tool 链、原始 JSON 和上下文裁剪前后结果。

**Architecture:** Agent Core 只依赖中立的 `RuntimeEventSink`，通过可选注入发送运行事实；Tap Adapter 实现该端口，将事件顺序写入 JSONL 并通过 SSE 推送给原生单页 Viewer。依赖方向固定为 `Tap -> RuntimeEventSink <- Agent Core`，Tap 失败不能影响 Agent。

**Tech Stack:** Node.js 22+、TypeScript、Node 内置 `http/fs/crypto`、SSE、原生 HTML/CSS/JavaScript、`node:test`

## Global Constraints

- Agent Core 不允许导入 `src/tap/**`、HTTP Server、Recorder 或 Viewer。
- 原有 `npm run agent` 必须可以在没有 Tap 的情况下独立运行。
- Tap 只绑定 `127.0.0.1`，默认端口 `4319`。
- Trace 只记录运行数据，不记录 API Key、请求 Header 和环境变量。
- 不引入 React、Web 框架、数据库或新增 npm 依赖。
- Tap 写入、序列化、SSE 推送或启动失败都不能阻断 Agent 主流程。
- 保留当前工作区已有的未提交改动；每次只暂存本任务明确列出的文件。

## File Map

- Create `src/runtime/events.ts`: 中立运行事件协议、安全发布器、No-op 行为。
- Modify `src/agent/types.ts`: 给 `AgentLoopOptions` 增加可选 `runtimeEventSink`。
- Modify `src/agent/loop.ts`: 在轮次、Context、模型和 Tool 边界发布通用事件。
- Create `test/runtime/events.test.ts`: 验证顺序和 sink 隔离。
- Create `src/tap/recorder.ts`: JSONL 队列写入、历史读取和内存订阅。
- Create `test/tap/recorder.test.ts`: 验证 JSONL、顺序、失败隔离和订阅。
- Create `src/tap/viewer.ts`: 自包含三栏 Viewer HTML。
- Create `src/tap/server.ts`: 静态页面、历史 API 和 SSE。
- Create `test/tap/server.test.ts`: 验证页面、历史和实时事件接口。
- Create `src/cli/run.ts`: 可注入 sink 的通用 CLI 组合函数。
- Modify `src/index.ts`: 保持原命令，只调用通用 CLI。
- Create `src/observe.ts`: Tap 专用组合根。
- Modify `package.json`: 增加 `observe` 脚本。
- Modify `.gitignore`: 忽略 `.traces/`。
- Modify `test/phase1/agent-loop.test.ts`: 验证完整事件链和 Context Diff 数据。

---

### Task 1: 中立运行事件端口与 Agent 事件链

**Files:**
- Create: `src/runtime/events.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Create: `test/runtime/events.test.ts`
- Modify: `test/phase1/agent-loop.test.ts`

**Interfaces:**
- Produces: `RuntimeEventType`、`RuntimeEvent`、`RuntimeEventSink`、`RuntimeEventPublisher`。
- Produces: `AgentLoopOptions.runtimeEventSink?: RuntimeEventSink`。
- Event order: `turn.start -> context.before -> context.after -> model.response -> tool.call/tool.result -> turn.end|turn.error`。

- [ ] **Step 1: 为安全发布器写失败测试**

```ts
// test/runtime/events.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeEventPublisher,
  type RuntimeEvent,
} from "../../src/runtime/events.js";

test("事件序号递增，sink 抛错不会向调用方传播", () => {
  const events: RuntimeEvent[] = [];
  const publisher = new RuntimeEventPublisher({
    emit(event) {
      events.push(event);
      if (event.type === "turn.end") throw new Error("tap failed");
    },
  });

  const turnId = publisher.createTurnId();
  publisher.emit("turn.start", turnId, { input: "你好" });
  assert.doesNotThrow(() => {
    publisher.emit("turn.end", turnId, { answer: "你好" });
  });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[0]?.sessionId, events[1]?.sessionId);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/runtime/events.test.ts`

Expected: FAIL，提示无法解析 `src/runtime/events.js`。

- [ ] **Step 3: 实现中立事件协议和安全发布器**

```ts
// src/runtime/events.ts
import { randomUUID } from "node:crypto";

export type RuntimeEventType =
  | "turn.start"
  | "context.before"
  | "context.after"
  | "model.response"
  | "tool.call"
  | "tool.result"
  | "turn.end"
  | "turn.error";

export interface RuntimeEvent<TPayload = unknown> {
  id: string;
  sessionId: string;
  turnId: string;
  step?: number;
  sequence: number;
  timestamp: string;
  type: RuntimeEventType;
  payload: TPayload;
}

export interface RuntimeEventSink {
  emit(event: RuntimeEvent): void;
}

export class RuntimeEventPublisher {
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(private readonly sink?: RuntimeEventSink) {}

  createTurnId(): string {
    return randomUUID();
  }

  emit(
    type: RuntimeEventType,
    turnId: string,
    payload: unknown,
    step?: number,
  ): void {
    if (!this.sink) return;
    const event: RuntimeEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      turnId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      payload,
      ...(step === undefined ? {} : { step }),
    };
    try {
      this.sink.emit(event);
    } catch {
      // 观测器失败不能影响 Agent。
    }
  }
}
```

- [ ] **Step 4: 给 AgentLoopOptions 增加可选端口**

```ts
// src/agent/types.ts
import type { RuntimeEventSink } from "../runtime/events.js";

export interface AgentLoopOptions {
  /** 可选运行事件出口；未提供时不产生观测副作用。 */
  runtimeEventSink?: RuntimeEventSink;
}
```

- [ ] **Step 5: 先写 Agent 事件链失败测试**

在 `test/phase1/agent-loop.test.ts` 导入事件类型，并给 `createAgent` 增加第四个参数：

```ts
import type { RuntimeEvent, RuntimeEventSink } from "../../src/runtime/events.js";

function createAgent(
  provider: FakeProvider,
  registry = new ToolRegistry(),
  contextManager: ContextBuilder = new ContextManager(
    new ProviderTokenCounter(provider),
  ),
  runtimeEventSink?: RuntimeEventSink,
): AgentLoop {
  return new AgentLoop({
    queryEngine: new QueryEngine(provider),
    toolRegistry: registry,
    contextManager,
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
    systemPrompt: "test prompt",
    ...(runtimeEventSink === undefined ? {} : { runtimeEventSink }),
  });
}
```

在现有“模型使用 Context 快照”用例中把 `contextSink` 作为第四个参数传入，并追加裁剪断言：

```ts
const contextEvents: RuntimeEvent[] = [];
const contextSink: RuntimeEventSink = { emit: (event) => contextEvents.push(event) };
const agent = createAgent(
  provider,
  new ToolRegistry(),
  new LatestMessageContextBuilder(),
  contextSink,
);
const secondAfter = contextEvents.filter(
  (event) => event.type === "context.after",
).at(-1);
assert.equal((secondAfter?.payload as ContextSnapshot).droppedMessageCount, 2);
```

在现有“诊断意图产生 Tool Call”用例中把 `toolSink` 作为第四个参数传入，并追加：

```ts
const toolEvents: RuntimeEvent[] = [];
const toolSink: RuntimeEventSink = { emit: (event) => toolEvents.push(event) };
const agent = createAgent(
  provider,
  registry,
  new ContextManager(new ProviderTokenCounter(provider)),
  toolSink,
);
assert.deepEqual(toolEvents.map((event) => event.type), [
  "turn.start", "context.before", "context.after", "model.response",
  "tool.call", "tool.result", "context.before", "context.after",
  "model.response", "turn.end",
]);
```

- [ ] **Step 6: 运行 Agent 测试并确认新增用例失败**

Run: `npm run test:phase1`

Expected: 新增事件链用例 FAIL，现有用例保持 PASS。

- [ ] **Step 7: 在 AgentLoop 边界发布事件**

在 `src/agent/loop.ts` 创建 `RuntimeEventPublisher`。每次 `run()` 创建一个 `turnId`，并用外层 `try/catch` 保证错误事件后原样抛出。关键调用形态如下：

```ts
private readonly runtimeEvents = new RuntimeEventPublisher(
  this.options.runtimeEventSink,
);

const turnId = this.runtimeEvents.createTurnId();
this.runtimeEvents.emit("turn.start", turnId, { input: userInput });

this.runtimeEvents.emit("context.before", turnId, {
  systemPrompt: this.options.systemPrompt,
  messages: [...this.messages],
  tools: this.options.toolRegistry.getSchemas(),
  maxContextTokens: this.options.maxContextTokens,
  reservedOutputTokens: this.options.maxOutputTokens,
}, step);

const contextSnapshot = await this.options.contextManager.build({
  ...(this.options.systemPrompt === undefined
    ? {}
    : { systemPrompt: this.options.systemPrompt }),
  messages: this.messages,
  tools: this.options.toolRegistry.getSchemas(),
  maxContextTokens: this.options.maxContextTokens,
  reservedOutputTokens: this.options.maxOutputTokens,
});
this.runtimeEvents.emit("context.after", turnId, contextSnapshot, step);

const response = await this.options.queryEngine.query(queryParams);
this.runtimeEvents.emit("model.response", turnId, {
  request: {
    systemPrompt: contextSnapshot.systemPrompt,
    messages: contextSnapshot.messages,
    tools: contextSnapshot.tools,
    maxTokens: this.options.maxOutputTokens,
    temperature: 0,
  },
  response,
}, step);

this.runtimeEvents.emit("tool.call", turnId, call, step);
// dispatchToolCall 后：
this.runtimeEvents.emit("tool.result", turnId, dispatched, step);
// 最终文本入历史后：
this.runtimeEvents.emit("turn.end", turnId, { answer }, step);
```

错误出口使用：

```ts
} catch (error: unknown) {
  this.runtimeEvents.emit("turn.error", turnId, {
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
```

- [ ] **Step 8: 验证事件协议与 Agent 行为**

Run: `npx tsx --test test/runtime/events.test.ts && npm run test:phase1 && npm run typecheck:phase1`

Expected: 全部 PASS；未注入 sink 的旧用例输出不变。

- [ ] **Step 9: 提交中立事件能力**

```bash
git add src/runtime/events.ts src/agent/types.ts src/agent/loop.ts test/runtime/events.test.ts test/phase1/agent-loop.test.ts
git commit -m "feat: expose agent runtime events"
```

---

### Task 2: JSONL Recorder 与实时订阅

**Files:**
- Create: `src/tap/recorder.ts`
- Create: `test/tap/recorder.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent`、`RuntimeEventSink`。
- Produces: `TapRecorder implements RuntimeEventSink`。
- Produces: `readEvents(): Promise<RuntimeEvent[]>`、`subscribe(listener): () => void`、`flush(): Promise<void>`。

- [ ] **Step 1: 写 Recorder 失败测试**

```ts
// test/tap/recorder.test.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/tap/recorder.test.ts`

Expected: FAIL，提示无法解析 `src/tap/recorder.js`。

- [ ] **Step 3: 实现 Recorder**

`src/tap/recorder.ts` 使用 `appendFile` 串行 Promise 队列，避免并发写入乱序：

```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeEvent, RuntimeEventSink } from "../runtime/events.js";

type Listener = (event: RuntimeEvent) => void;

function serializeEvent(event: RuntimeEvent): string {
  try {
    return JSON.stringify(event);
  } catch (error: unknown) {
    return JSON.stringify({
      ...event,
      payload: {
        serializationError: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export class TapRecorder implements RuntimeEventSink {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = console.warn,
  ) {}

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* 隔离 Viewer 订阅者。 */ }
    }
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${serializeEvent(event)}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.onWarning(`Tap trace 写入失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readEvents(): Promise<RuntimeEvent[]> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
```

- [ ] **Step 4: 增加失败隔离测试**

使用一个不可写路径创建 Recorder，调用 `emit()` 和 `flush()`，断言 `flush()` resolve 且 `onWarning` 收到一次消息。不要依赖固定系统目录权限；把 `filePath` 指向已创建的普通文件之下，例如 `<temp>/parent-file/trace.jsonl`，确保 `mkdir` 返回 `ENOTDIR`。

再构造带循环引用的 payload，断言写入的 JSONL 仍可解析且包含 `payload.serializationError`：

```ts
const circular: Record<string, unknown> = {};
circular.self = circular;
recorder.emit({ ...event, id: "event-circular", payload: circular });
await recorder.flush();
const saved = await recorder.readEvents();
assert.equal(typeof (saved.at(-1)?.payload as { serializationError: string }).serializationError, "string");
```

- [ ] **Step 5: 验证 Recorder**

Run: `npx tsx --test test/tap/recorder.test.ts && npm run typecheck`

Expected: Recorder 用例 PASS；若全项目 typecheck 存在任务前已有错误，记录完整错误并至少运行 `npx tsc --noEmit --pretty false` 确认本任务文件没有新增错误。

- [ ] **Step 6: 提交 Recorder**

```bash
git add src/tap/recorder.ts test/tap/recorder.test.ts
git commit -m "feat: record runtime traces"
```

---

### Task 3: 本地 Server 与三栏 Viewer

**Files:**
- Create: `src/tap/viewer.ts`
- Create: `src/tap/server.ts`
- Create: `test/tap/server.test.ts`

**Interfaces:**
- Consumes: `TapRecorder.readEvents()`、`TapRecorder.subscribe()`。
- Produces: `startTapServer(options): Promise<TapServerHandle>`。
- `TapServerHandle`: `{ url: string; close(): Promise<void> }`。

- [ ] **Step 1: 写 HTTP 与 SSE 失败测试**

```ts
// test/tap/server.test.ts
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TapRecorder } from "../../src/tap/recorder.js";
import { startTapServer } from "../../src/tap/server.js";

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
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/tap/server.test.ts`

Expected: FAIL，提示无法解析 `src/tap/server.js`。

- [ ] **Step 3: 实现自包含 Viewer**

在 `src/tap/viewer.ts` 导出 `VIEWER_HTML`。页面必须包含：

```ts
export const VIEWER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>DKAgent Tap</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, monospace; }
    body { margin: 0; background: #0b0d10; color: #e7e9ee; }
    header { height: 48px; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid #252a33; }
    main { display: grid; grid-template-columns: 240px minmax(320px, 1fr) minmax(360px, 1fr); height: calc(100vh - 49px); }
    section { overflow: auto; border-right: 1px solid #252a33; padding: 12px; }
    button, article { width: 100%; box-sizing: border-box; text-align: left; color: inherit; background: #141820; border: 1px solid #252a33; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
    .active { border-color: #66d9a8; }
    .removed { border-color: #ff6b6b; background: #2a1518; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
    @media (max-width: 900px) { main { grid-template-columns: 180px 1fr; } #detail { grid-column: 1 / -1; } }
  </style>
</head>
<body>
  <header><strong>DKAgent Tap</strong><span id="status">连接中</span></header>
  <main><section id="turns"></section><section id="flow"></section><section id="detail"><div id="diff"></div><pre id="json"></pre></section></main>
  <script>
    const state = { events: [], activeTurnId: null, selectedId: null };
    const stable = (value) => JSON.stringify(value);
    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const summary = (event) => {
      if (event.type === 'turn.start') return event.payload.input;
      if (event.type === 'tool.call') return event.payload.name;
      if (event.type === 'tool.result') return event.payload.name;
      if (event.type === 'turn.end') return event.payload.answer;
      if (event.type === 'context.after') return event.payload.estimatedInputTokens + ' / ' + event.payload.availableInputTokens + ' tokens';
      return event.type;
    };
    const contextPair = (event) => {
      if (event.type !== 'context.after') return null;
      const before = state.events.find((item) => item.type === 'context.before' && item.turnId === event.turnId && item.step === event.step);
      return before ? { before: before.payload.messages, after: event.payload.messages } : null;
    };
    const removedMessages = (pair) => {
      if (!pair) return [];
      const remaining = new Map();
      for (const message of pair.after) {
        const key = stable(message);
        remaining.set(key, (remaining.get(key) ?? 0) + 1);
      }
      return pair.before.filter((message) => {
        const key = stable(message);
        const count = remaining.get(key) ?? 0;
        if (count === 0) return true;
        remaining.set(key, count - 1);
        return false;
      });
    };
    function render() {
      const turns = [...new Set(state.events.map((event) => event.turnId))];
      state.activeTurnId ??= turns.at(-1) ?? null;
      document.querySelector('#turns').innerHTML = turns.map((id, index) => '<button class="' + (id === state.activeTurnId ? 'active' : '') + '" data-turn="' + id + '">第 ' + (index + 1) + ' 轮</button>').join('');
      const visible = state.events.filter((event) => event.turnId === state.activeTurnId);
      document.querySelector('#flow').innerHTML = visible.map((event) => '<article data-id="' + event.id + '"><strong>' + escapeHtml(event.type) + '</strong><small> step ' + (event.step ?? '-') + '</small><p>' + escapeHtml(summary(event)) + '</p></article>').join('');
      const selected = state.events.find((event) => event.id === state.selectedId) ?? visible.at(-1);
      if (!selected) return;
      const pair = contextPair(selected);
      const removed = removedMessages(pair);
      document.querySelector('#diff').innerHTML = removed.length ? '<h3>压缩移除</h3>' + removed.map((message) => '<article class="removed"><pre>' + escapeHtml(JSON.stringify(message, null, 2)) + '</pre></article>').join('') : '';
      document.querySelector('#json').textContent = JSON.stringify({ event: selected, contextDiff: pair ? { ...pair, removed: removedMessages(pair) } : null }, null, 2);
    }
    document.addEventListener('click', (event) => {
      const turnId = event.target.closest('[data-turn]')?.dataset.turn;
      const eventId = event.target.closest('[data-id]')?.dataset.id;
      if (turnId) { state.activeTurnId = turnId; state.selectedId = null; render(); }
      if (eventId) { state.selectedId = eventId; render(); }
    });
    fetch('/api/events').then((response) => response.json()).then((events) => { state.events = events; render(); });
    const stream = new EventSource('/api/events/stream');
    stream.onopen = () => document.querySelector('#status').textContent = '实时连接';
    stream.onmessage = (message) => { state.events.push(JSON.parse(message.data)); render(); };
    stream.onerror = () => document.querySelector('#status').textContent = '重连中';
  </script>
</body>
</html>`;
```

保持上述单文件实现；不能增加框架、图表、搜索、主题切换或编辑能力。

- [ ] **Step 4: 实现 Server**

`src/tap/server.ts` 使用 `node:http`：

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TapRecorder } from "./recorder.js";
import { VIEWER_HTML } from "./viewer.js";

export interface TapServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startTapServer(options: {
  recorder: TapRecorder;
  host?: string;
  port?: number;
}): Promise<TapServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const clients = new Set<NodeJS.WritableStream>();
  const unsubscribe = options.recorder.subscribe((event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(frame);
  });
  const server = createServer(async (request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(VIEWER_HTML);
      return;
    }
    if (request.url === "/api/events") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(await options.recorder.readEvents()));
      return;
    }
    if (request.url === "/api/events/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4319, host, resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      unsubscribe();
      for (const client of clients) client.end();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
```

- [ ] **Step 5: 验证 Server 与 Viewer**

Run: `npx tsx --test test/tap/server.test.ts test/tap/recorder.test.ts && npm run typecheck`

Expected: Tap 测试 PASS；页面包含三栏容器，历史 API 返回数组，SSE Content-Type 正确。

- [ ] **Step 6: 提交本地 Viewer**

```bash
git add src/tap/viewer.ts src/tap/server.ts test/tap/server.test.ts
git commit -m "feat: add local trace viewer"
```

---

### Task 4: 独立组合根与端到端验收

**Files:**
- Create: `src/cli/run.ts`
- Modify: `src/index.ts`
- Create: `src/observe.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `RuntimeEventSink`、`TapRecorder`、`startTapServer()`。
- Produces: `runAgentCli(options?: { runtimeEventSink?: RuntimeEventSink }): Promise<void>`。
- Produces: `npm run observe`，启动 Tap 后运行原有 CLI。

- [ ] **Step 1: 提取可注入的 CLI 函数**

创建以下 `src/cli/run.ts`：

```ts
import { createInterface } from "node:readline";
import { AgentLoop } from "../agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../agent/prompt.js";
import { loadConfig } from "../config.js";
import { ContextManager, ProviderTokenCounter } from "../context/index.js";
import { OpenAICompatibleProvider } from "../query-engine/providers/openai-compatible.js";
import { QueryEngine } from "../query-engine/query-engine.js";
import { createToolRegistry } from "../tools/index.js";
import type { RuntimeEventSink } from "../runtime/events.js";
import { createSafePrompt } from "./safe-prompt.js";

export async function runAgentCli(options: {
  runtimeEventSink?: RuntimeEventSink;
} = {}): Promise<void> {
  const config = loadConfig();
  const provider = new OpenAICompatibleProvider(config.apiKey, config.baseURL);
  const queryEngine = new QueryEngine(provider);
  const toolRegistry = createToolRegistry();
  const contextManager = new ContextManager(new ProviderTokenCounter(provider));
  const agent = new AgentLoop({
    queryEngine,
    toolRegistry,
    contextManager,
    model: config.model,
    maxContextTokens: config.maxContextTokens,
    maxOutputTokens: config.maxOutputTokens,
    maxSteps: 4,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    onTextDelta: (text) => process.stdout.write(text),
    ...(options.runtimeEventSink === undefined
      ? {}
      : { runtimeEventSink: options.runtimeEventSink }),
  });

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  console.log("DKAgent 已启动，输入自然语言开始对话，按 Ctrl+C 退出。\n");
  readline.setPrompt("> ");
  const prompt = createSafePrompt(readline);
  prompt();

  for await (const input of readline) {
    const userInput = input.trim();
    if (!userInput) {
      prompt();
      continue;
    }
    try {
      await agent.run(userInput);
      process.stdout.write("\n\n");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nAgent 运行失败：${message}\n`);
    }
    prompt();
  }
}
```

`src/index.ts` 只保留：

```ts
import "dotenv/config";
import { runAgentCli } from "./cli/run.js";

runAgentCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nAgent 运行失败：${message}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: 创建 Tap 专用组合根**

```ts
// src/observe.ts
import "dotenv/config";
import { join } from "node:path";
import { runAgentCli } from "./cli/run.js";
import { TapRecorder } from "./tap/recorder.js";
import { startTapServer } from "./tap/server.js";
import type { TapServerHandle } from "./tap/server.js";

async function main(): Promise<void> {
const tracePath = join(process.cwd(), ".traces", "events.jsonl");
  const recorder = new TapRecorder(tracePath);
  let server: TapServerHandle;
  try {
    server = await startTapServer({ recorder });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`DKAgent Tap 启动失败，将继续运行 Agent：${message}`);
    await runAgentCli();
    return;
  }

  console.log(`DKAgent Tap：${server.url}`);
  try {
    await runAgentCli({ runtimeEventSink: recorder });
  } finally {
    await recorder.flush();
    await server.close();
  }
}

await main();
```

- [ ] **Step 3: 增加命令与 Trace 忽略规则**

在 `package.json` scripts 增加：

```json
"observe": "tsx src/observe.ts"
```

在 `.gitignore` 增加：

```gitignore
# Local Agent traces
.traces/
```

- [ ] **Step 4: 运行全套自动验证**

Run: `npm test`

Expected: 全部测试 PASS。

Run: `npm run typecheck`

Expected: PASS。若任务开始前已存在失败，必须对比实现前基线，确认没有新增错误，并在交付中列出仍存在的原始错误。

Run: `rg -n 'from ["\x27].*tap/' src/agent src/context src/query-engine src/tools src/runtime`

Expected: 无输出，证明 Agent Core 没有反向依赖 Tap。

- [ ] **Step 5: 最小人工验收**

Run: `npm run observe`

Expected: 终端同时显示原有 `DKAgent 已启动` 和 `DKAgent Tap：http://127.0.0.1:4319/`。

在终端完成两轮对话，其中一轮触发 Tool；临时使用较小 `MAX_CONTEXT_TOKENS` 触发裁剪。浏览器确认：

1. 左栏出现两轮及对应 Step。
2. 中栏按顺序出现 User、Tool Call、Tool Result、Assistant。
3. 右栏能查看原始事件 JSON。
4. 选择 `context.after` 后能看到 Before、After、removed 和 Token 数据。
5. 关闭浏览器后终端对话继续工作；重新打开 URL 后历史事件恢复。

- [ ] **Step 6: 提交组合根**

```bash
git add src/cli/run.ts src/index.ts src/observe.ts package.json .gitignore
git commit -m "feat: wire DKAgent Tap observer"
```

- [ ] **Step 7: 最终状态检查**

Run: `git status --short`

Expected: 只显示任务开始前已有的用户改动，不出现本计划新增文件的未提交变更。
