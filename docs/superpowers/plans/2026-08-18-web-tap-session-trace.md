# Web Tap Session Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Web Tap 增加只读 Session 列表与真实 Session–Trace 关联，并为节点增加模块 Tag 和字符串 `content` 的 Markdown 展示。

**Architecture:** CLI 在执行 AgentLoop 前通过 Tracer 异步上下文绑定当前 `sessionId`；Trace 仍写入 `MemoryTraceStore`，Session 仍写入 SQLite。Tap Server 同时注入 Trace Store 和只读 Session Reader，前端按 `Session → Turn → Step → Node` 展示；未来只替换 Trace Store 即可接数据库。

**Tech Stack:** TypeScript、Node.js、better-sqlite3、React 19、Vite 8、Ant Design 6、Zustand 5、React Router、react-markdown、Node Test、Vitest。

## Global Constraints

- Web Tap 只读 Session，不提供创建、切换或删除接口。
- `sessionId` 只定义在 Trace 日志侧，不写入 AgentMessage、Memory、Context 或 Tool 数据。
- 无 Trace 的历史 Session 展示真实消息和“暂无运行轨迹”，不推测 Step、Node 或指标。
- 模块 Tag 与状态颜色相互独立，状态不能只靠颜色表达。
- 只把已解析的 System、User、Assistant 字符串 `content` 渲染为 Markdown；Tool 结果和 Raw JSON 保持现状。
- 不启用 Markdown 原始 HTML。
- 当前使用 MemoryTraceStore；本版不实现 Trace 数据库。
- 只修改需求直接涉及的文件，不处理未跟踪的 `test.md`。

---

## File Structure

### 新建文件

- `packages/web-tap/src/tap/session-reader.ts`：把 Agent SessionStore 适配为 Tap 只读模型。
- `packages/web-tap/src/web/api/session-api.ts`：读取 Session 列表和详情。
- `packages/web-tap/src/web/app/WebTapRouter.tsx`：组合 Session 列表和详情路由。
- `packages/web-tap/src/web/features/sessions/SessionListPage.tsx`：只读 Session 入口页。
- `packages/web-tap/src/web/features/sessions/SessionHistory.tsx`：无 Trace 时展示真实消息。
- `packages/web-tap/src/web/features/timeline/ModuleTag.tsx`：统一模块标签。
- `packages/web-tap/src/web/features/node-detail/MarkdownContent.tsx`：安全 Markdown 文本。
- `packages/trace/test/tracer-session.test.ts`：Session 上下文传播测试。

### 修改文件

- `packages/trace/src/types.ts`、`tracer.ts`：增加日志侧 `sessionId` 和 `withSession`。
- `packages/trace/package.json`：让 root test 能运行 Trace 测试。
- `packages/agent/package.json`、`src/session/index.ts`、`src/cli/run.ts`：公开 Session API并允许组合根注入 Store。
- `packages/web-tap/src/observe.ts`、`src/tap/server.ts`：组装共享 Store，增加只读 Session API 和 SPA fallback。
- `packages/web-tap/src/web/model/types.ts`、`project-events.ts`：按 `sessionId` 投影并派生模块类型。
- `packages/web-tap/src/web/api/event-feed.ts`、`store/tap-store.ts`：按当前 Session 读取和跟随 Trace。
- `packages/web-tap/src/web/app/TapApp.tsx`、`src/web/main.tsx`：接收 Session 路由参数并组合页面。
- `packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx`、`NodeDetail.tsx`：只替换合适的 `content` DOM。
- `packages/web-tap/src/web/features/timeline/NodeNav.tsx`、`styles.css`：显示语义 Tag 和 Session 页面样式。
- `packages/web-tap/package.json`、根 `package-lock.json`：加入 React Router 和 react-markdown。
- 现有 Trace、Server、Store、App 测试：覆盖新增契约和回归。

---

### Task 1: Trace Session 上下文

**Files:**
- Modify: `packages/trace/src/types.ts`
- Modify: `packages/trace/src/tracer.ts`
- Modify: `packages/trace/package.json`
- Modify: `packages/agent/src/cli/run.ts`
- Test: `packages/trace/test/tracer-session.test.ts`

**Interfaces:**
- Produces: `TraceEvent.sessionId?: string`
- Produces: `Tracer.withSession<T>(sessionId: string, operation: () => T | Promise<T>): T | Promise<T>`
- Consumes: CLI 当前 `currentSession.id`

- [ ] **Step 1: 写 Session 传播失败测试**

```ts
test("withSession 让根 Trace、子 Span 和 Event 继承 sessionId", async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer(store);

  await tracer.withSession("session-1", () => tracer.trace(
    "agent.turn",
    { input: "你好" },
    async () => tracer.span("model.request", {}, async (span) => {
      span.event("context.tokens.counted", { tokens: 12 });
    }),
  ));

  assert.equal(store.list().length > 0, true);
  assert.equal(store.list().every((event) => event.sessionId === "session-1"), true);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx tsx --test packages/trace/test/tracer-session.test.ts`

Expected: FAIL，提示 `withSession` 或 `sessionId` 不存在。

- [ ] **Step 3: 实现最小 Trace 上下文**

```ts
export interface TraceEvent<TData = unknown> {
  sessionId?: string;
  // existing fields
}

interface ActiveTraceContext {
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  step?: number;
}

public withSession<T>(
  sessionId: string,
  operation: () => T | Promise<T>,
): T | Promise<T> {
  return this.context.run({ ...this.context.getStore(), sessionId }, operation);
}
```

根 Trace、Span、Event 和 `publish` 的上下文都透传 `sessionId`。在 CLI 普通输入分支使用：

```ts
await tracer.withSession(currentSession.id, () => agent.run(userInput));
```

- [ ] **Step 4: 将 Trace 测试接入 workspace test 并验证 GREEN**

在 `packages/trace/package.json` 增加：

```json
"scripts": {
  "test": "cd ../.. && tsx --test packages/trace/test/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

Run: `npm test -w @dkagent/trace && npm run typecheck -w @dkagent/trace && npm run typecheck -w @dkagent/agent`

Expected: Trace 测试全部 PASS，两个包 typecheck 退出码 0。

- [ ] **Step 5: 提交**

```bash
git add packages/trace packages/agent/src/cli/run.ts
git commit -m "feat(trace): correlate events with sessions"
```

---

### Task 2: Session Reader 与只读 API

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/agent/src/session/index.ts`
- Modify: `packages/agent/src/cli/run.ts`
- Create: `packages/web-tap/src/tap/session-reader.ts`
- Modify: `packages/web-tap/src/tap/server.ts`
- Modify: `packages/web-tap/src/observe.ts`
- Test: `packages/web-tap/test/server.test.ts`
- Test: `packages/web-tap/test/observe.test.ts`

**Interfaces:**
- Consumes: `TraceEvent.sessionId`, `SessionStore.list/load`
- Produces: `TapSessionReader.list()`、`TapSessionReader.load(sessionId)`
- Produces: `GET /api/sessions`、`GET /api/sessions/:id`、`GET /api/sessions/:id/events`

- [ ] **Step 1: 写 API 失败测试**

在 server 测试中注入固定 Reader：

```ts
const sessions = {
  list: () => [{
    id: "session-1",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:01:00.000Z",
    preview: "你好",
    messageCount: 2,
    turnCount: 1,
    hasTrace: true,
  }],
  load: (id: string) => id === "session-1" ? {
    id,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:01:00.000Z",
    messages: [{ role: "user", content: "你好" }],
    contextSummary: "",
  } : null,
};
```

断言列表、详情、404，以及 events 只返回 `sessionId === "session-1"` 的事件。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx tsx --test packages/web-tap/test/server.test.ts`

Expected: FAIL，`startTapServer` 尚不接受 Session Reader，接口返回 404。

- [ ] **Step 3: 实现 Tap 只读模型与 Adapter**

```ts
export interface TapSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  messageCount: number;
  turnCount: number;
  hasTrace: boolean;
}

export interface TapSessionReader {
  list(): TapSessionSummary[];
  load(sessionId: string): TapSessionDetail | null;
}
```

Adapter 使用 `SessionStore.list()` 和 `load()` 计算首条 User 消息预览、消息数和 User 消息数，不修改 Agent 类型。`hasTrace` 由 Reader 组合 Trace Store 计算。

- [ ] **Step 4: 实现 API、SPA fallback 与资源所有权**

`startTapServer` 增加必需的 `sessions: TapSessionReader`；API 路由优先于静态路由。只有不带扩展名且不属于 `/api/` 的页面路径才回退 `index.html`，缺失 assets 继续 404。

Agent 导出 `@dkagent/agent/session`；`runAgentCli` 接受可选 `sessionStore`，仅关闭内部创建的 Store。`observe.ts` 创建并最终关闭共享 Store。

- [ ] **Step 5: 验证 GREEN 和回归**

Run: `npx tsx --test packages/web-tap/test/server.test.ts packages/web-tap/test/observe.test.ts`

Expected: 新旧 Server/observe 测试全部 PASS。

Run: `npm run typecheck -w @dkagent/web-tap && npm run typecheck -w @dkagent/agent`

Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add packages/agent packages/web-tap/src/observe.ts packages/web-tap/src/tap packages/web-tap/test/server.test.ts packages/web-tap/test/observe.test.ts
git commit -m "feat(web-tap): expose read-only session APIs"
```

---

### Task 3: 前端 Session 投影、Store 与路由

**Files:**
- Modify: `packages/web-tap/package.json`
- Modify: `package-lock.json`
- Create: `packages/web-tap/src/web/api/session-api.ts`
- Create: `packages/web-tap/src/web/app/WebTapRouter.tsx`
- Create: `packages/web-tap/src/web/features/sessions/SessionListPage.tsx`
- Create: `packages/web-tap/src/web/features/sessions/SessionHistory.tsx`
- Modify: `packages/web-tap/src/web/api/event-feed.ts`
- Modify: `packages/web-tap/src/web/model/types.ts`
- Modify: `packages/web-tap/src/web/model/project-events.ts`
- Modify: `packages/web-tap/src/web/store/tap-store.ts`
- Modify: `packages/web-tap/src/web/app/TapApp.tsx`
- Modify: `packages/web-tap/src/web/main.tsx`
- Modify: `packages/web-tap/src/web/styles.css`
- Test: `packages/web-tap/test/web/project-events.test.ts`
- Test: `packages/web-tap/test/web/tap-store.test.ts`
- Test: `packages/web-tap/test/web/tap-app.test.tsx`

**Interfaces:**
- Consumes: Session API 和带 `sessionId` 的 TraceEvent
- Produces: `/` Session 列表与 `/sessions/:sessionId` 详情
- Produces: `projectEvents(events)` 按 Session 分组

- [ ] **Step 1: 写投影与 Store RED 测试**

覆盖：两个 `sessionId` 生成两个 Session；未关联事件进入 `unlinked`；选择 Session 后只读取该 Session 的 `/events`；其他 Session 的 SSE 事件不跳转当前页面。

```ts
expect(projectEvents([
  { ...first, sessionId: "session-a" },
  { ...second, sessionId: "session-b" },
]).map((session) => session.id)).toEqual(["session-a", "session-b"]);
```

- [ ] **Step 2: 运行 focused 测试并确认 RED**

Run: `npm run test:web -w @dkagent/web-tap -- --run test/web/project-events.test.ts test/web/tap-store.test.ts`

Expected: FAIL，当前投影仍只有固定 `current` Session。

- [ ] **Step 3: 实现按 Session 投影和 Event Feed**

删除 `CURRENT_SESSION_ID`。`projectEvents` 按 `event.sessionId ?? "unlinked"` 建立 `TapSessionView`；同一 Session 内仍按 `traceId` 生成 Turn。

`connectEventFeed(store, { sessionId })` 首次读取：

```ts
fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
```

SSE 只把同 Session 事件追加到当前详情 Store。

- [ ] **Step 4: 安装最小页面依赖并实现路由**

Run: `npm install react-router-dom react-markdown -w @dkagent/web-tap`

`WebTapRouter` 使用 `BrowserRouter/Routes/Route`；列表页读取 `/api/sessions`，支持本地搜索并导航到 `/sessions/:id`。详情页把参数传给 `TapApp sessionId={sessionId}`。

无 Trace 时 `SessionHistory` 展示真实 System/User/Assistant 消息，并显示“暂无运行轨迹”；不渲染 TurnList、NodeNav 或 AgentInsights。

- [ ] **Step 5: 写页面测试并验证 GREEN**

使用 `MemoryRouter` 覆盖：Session 列表、搜索、进入详情、无 Trace 历史消息、Session 404 返回入口。

Run: `npm run test:web -w @dkagent/web-tap -- --run test/web/project-events.test.ts test/web/tap-store.test.ts test/web/tap-app.test.tsx`

Expected: focused 测试全部 PASS。

Run: `npm run typecheck -w @dkagent/web-tap`

Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add package-lock.json packages/web-tap
git commit -m "feat(web-tap): add session list and detail routes"
```

---

### Task 4: 模块 Tag 与 Markdown content

**Files:**
- Create: `packages/web-tap/src/web/features/timeline/ModuleTag.tsx`
- Create: `packages/web-tap/src/web/features/node-detail/MarkdownContent.tsx`
- Modify: `packages/web-tap/src/web/model/types.ts`
- Modify: `packages/web-tap/src/web/model/project-events.ts`
- Modify: `packages/web-tap/src/web/features/timeline/NodeNav.tsx`
- Modify: `packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx`
- Modify: `packages/web-tap/src/web/features/node-detail/NodeDetail.tsx`
- Modify: `packages/web-tap/src/web/styles.css`
- Test: `packages/web-tap/test/web/project-events.test.ts`
- Test: `packages/web-tap/test/web/tap-app.test.tsx`

**Interfaces:**
- Produces: `TapModuleKind = "session" | "context" | "memory" | "skill" | "tool" | "model" | "agent" | "other"`
- Produces: `TapNodeView.module`
- Produces: `<MarkdownContent content: string>`

- [ ] **Step 1: 写 Tag 与 Markdown RED 测试**

断言事件前缀映射到对应 `module`；页面显示中文 Tag。传入 `content: "# 标题\n\n- 项目"` 时断言存在 heading/list，而 Raw JSON 仍包含原始 Markdown 字符串；Tool result 仍使用现有字段/JSON 展示。

- [ ] **Step 2: 运行 focused 测试并确认 RED**

Run: `npm run test:web -w @dkagent/web-tap -- --run test/web/project-events.test.ts test/web/tap-app.test.tsx`

Expected: FAIL，当前无 module 字段且 content 只显示普通字符串。

- [ ] **Step 3: 实现模块投影和 Tag**

```ts
export function moduleForEvent(eventType: string): TapModuleKind {
  const prefix = eventType.split(".", 1)[0];
  return isTapModuleKind(prefix) ? prefix : "other";
}
```

`ModuleTag` 只负责中文单词和 CSS class。Node 状态继续使用现有圆点与文字。

- [ ] **Step 4: 实现安全 Markdown DOM**

`MarkdownContent` 使用 `react-markdown`，不传 `rehypePlugins`，不启用 `rehype-raw`。`FieldDescriptions` 增加明确的 Markdown 开关；System/User/Assistant 消息和模型正文开启，Tool call/result renderer 不开启。非字符串 `content` 沿用当前 JSON。

- [ ] **Step 5: 验证 GREEN、类型和 Ant Design 用法**

Run: `npm run test:web -w @dkagent/web-tap -- --run test/web/project-events.test.ts test/web/tap-app.test.tsx`

Expected: focused 测试全部 PASS。

Run: `npm run typecheck -w @dkagent/web-tap`

Expected: 退出码 0。

- [ ] **Step 6: 提交**

```bash
git add packages/web-tap/src/web packages/web-tap/test/web
git commit -m "feat(web-tap): add module tags and markdown content"
```

---

### Task 5: 集成回归与真实 Tap 验证

**Files:**
- Modify only if verification finds a requirement regression in files already listed above.

**Interfaces:**
- Consumes: Tasks 1–4 完整链路
- Produces: 可验证的 Session Trace Viewer MVP

- [ ] **Step 1: 运行 scoped 自动验证**

```bash
npm test -w @dkagent/trace
npm run test:session -w @dkagent/agent
npm run test -w @dkagent/web-tap
npm run typecheck -w @dkagent/trace
npm run typecheck -w @dkagent/agent
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
git diff --check
```

Expected: 所有命令退出码 0。若失败，只修复本功能引入的回归；与 `test.md` 等用户文件无关的问题如实报告。

- [ ] **Step 2: 运行真实 observe 验证**

Run: `npm run observe`

手工验证：

1. Session 列表能看到现有 SQLite Session。
2. 新对话 Trace 只进入当前 Session。
3. `/new` 后新 Trace 不串入旧 Session。
4. 无 Trace Session 显示消息与“暂无运行轨迹”。
5. System/User/Assistant content 渲染 Markdown，Tool 结果与 Raw JSON 未改变。

- [ ] **Step 3: 浏览器响应式与控制台检查**

检查桌面宽屏和 390px：Session 列表、返回、Turn Drawer、Agent 指标 Drawer 可操作，无页面级横向滚动；浏览器控制台没有本版新增错误。

- [ ] **Step 4: 最终范围审查**

Run: `git status --short && git diff main...HEAD --stat && git diff main...HEAD -- packages/agent/src/agent packages/agent/src/context packages/agent/src/memory packages/agent/src/tools`

Expected: 工作树只剩用户原有 `test.md`；AgentLoop、Context、Memory、Tool 业务实现没有本需求之外的改动。

- [ ] **Step 5: 必要修复后提交**

```bash
git add packages/trace packages/agent/src/cli/run.ts packages/agent/src/session packages/web-tap package-lock.json
git commit -m "fix(web-tap): complete session trace integration"
```

若无修复，不创建空提交。
