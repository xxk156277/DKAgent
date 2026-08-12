# DKAgent Tap V2 Session Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `packages/web-tap` 升级为 React + Vite + Ant Design + Zustand 的 Session 详情页，按 `Turn -> Step -> Node` 可视化 AgentLoop，并展示节点汉化字段、原始 JSON 与上下文裁剪过程。

**Architecture:** Agent 继续只发布中立 `RuntimeEvent`；web-tap 的纯投影层把事件转换为 Turn、Step、Node，再由 Zustand 保存原始事件和跨栏选择状态。Node HTTP Server 继续提供 History API 与 SSE，并托管 Vite 构建产物；React 三栏页面只读消费这些数据，不反向控制 Agent。

**Tech Stack:** React 19、TypeScript、Vite 8、Ant Design 6、Zustand 5、Vitest 4、Testing Library、Node HTTP/SSE

## Global Constraints

- 第一版只实现 Session 详情页，不实现 Session 列表页、面包屑和网页输入框。
- 页面层级固定为 `Session -> Turn（用户输入）-> Step（AgentLoop 循环）-> Node（运行节点）`。
- 左栏展示 Turn，中栏展示节点详情，右栏按 Step 分组展示 Node。
- 关键展示标签汉化，但 Runtime Event 原字段和值必须完整保留在原始 JSON 中。
- 第一版只根据现有 `context.before/context.after` 证明并展示直接裁剪，不依赖或修改未提交的 Context Compressor。
- Agent Core 不得导入 React、Vite、Ant Design、Zustand 或 web-tap 实现。
- Tap 的记录、HTTP、SSE、构建产物或页面异常不得影响 AgentLoop。
- 保留 `/api/events`、`/api/events/stream`、`127.0.0.1:4319` 和根命令 `npm run observe`。
- 不修改或提交当前工作区已有的 `packages/agent/src/context/index.ts`、`types.ts`、`compressor.ts` 变更。

---

## File Structure

```text
packages/web-tap/
├── index.html                         # Vite HTML 入口
├── package.json                       # React/Vite/Antd/Zustand 与构建测试脚本
├── tsconfig.json                      # Node 端与现有测试配置
├── tsconfig.web.json                  # 浏览器端 JSX/Bundler 配置
├── vite.config.ts                     # 构建到 dist，开发代理 API/SSE
├── src/
│   ├── observe.ts                     # 构建产物路径注入 TapServer
│   ├── tap/
│   │   ├── recorder.ts                # 保持 JSONL/SSE 记录职责
│   │   ├── server.ts                  # API + 安全静态文件托管
│   │   └── viewer-state.ts            # 历史和实时事件合并
│   └── web/
│       ├── main.tsx                   # React/ConfigProvider 入口
│       ├── styles.css                 # 三栏响应式样式
│       ├── api/event-feed.ts          # fetch + EventSource 生命周期
│       ├── model/types.ts             # Turn/Step/Node View Model
│       ├── model/project-events.ts     # RuntimeEvent -> View Model 纯投影
│       ├── model/context-diff.ts       # Context Before/After 消息差异
│       ├── store/tap-store.ts          # Zustand 原始事件与选择状态
│       ├── app/TapApp.tsx              # 页面组合根
│       ├── features/turns/TurnList.tsx # 左栏
│       ├── features/timeline/NodeNav.tsx # 右栏
│       ├── features/node-detail/NodeDetail.tsx # 中栏分派
│       ├── features/node-detail/FieldDescriptions.tsx
│       ├── features/compaction/ContextCompactionDetail.tsx
│       └── shared/RawJson.tsx          # JSON 折叠与复制
└── test/
    ├── web/
    │   ├── project-events.test.ts      # 投影与 Diff 单测
    │   ├── tap-store.test.ts           # Zustand 选择/跟随规则
    │   └── tap-app.test.tsx            # 三栏组件交互
    └── server.test.ts                  # 静态产物与 API/SSE 集成
```

---

### Task 1: 建立 React/Vite 可构建骨架

**Files:**
- Modify: `packages/web-tap/package.json`
- Modify: `packages/web-tap/tsconfig.json`
- Create: `packages/web-tap/tsconfig.web.json`
- Create: `packages/web-tap/vite.config.ts`
- Create: `packages/web-tap/index.html`
- Create: `packages/web-tap/src/web/main.tsx`
- Create: `packages/web-tap/src/web/app/TapApp.tsx`
- Create: `packages/web-tap/src/web/styles.css`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: existing workspace package `@dkagent/agent` and browser endpoints `/api/events`, `/api/events/stream`.
- Produces: `npm run build -w @dkagent/web-tap`, browser entry `src/web/main.tsx`, static output `packages/web-tap/dist`.

- [ ] **Step 1: Add a failing layout smoke test**

Create `packages/web-tap/test/web/tap-app.test.tsx` with a minimal assertion that the app renders three named regions:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TapApp } from "../src/web/app/TapApp.js";

describe("TapApp", () => {
  it("renders Turn list, node detail and node navigation", () => {
    render(<TapApp />);
    expect(screen.getByRole("heading", { name: "对话轮次" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "节点详情" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "节点导航" })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the web test and confirm the missing browser setup**

Run:

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-app.test.tsx
```

Expected: FAIL because `test:web`, React dependencies, Vitest config, or `TapApp` does not yet exist.

- [ ] **Step 3: Add exact package scripts and dependencies**

Set the web-tap scripts to:

```json
{
  "observe": "npm run build && cd ../.. && tsx packages/web-tap/src/observe.ts",
  "dev": "vite",
  "build": "vite build",
  "test": "npm run test:node && npm run test:web -- --run",
  "test:node": "cd ../.. && tsx --test packages/web-tap/test/*.test.ts",
  "test:web": "vitest",
  "typecheck": "tsc --noEmit && tsc -p tsconfig.web.json --noEmit"
}
```

Add runtime dependencies `react@^19.2.8`, `react-dom@^19.2.8`, `antd@^6.6.0`, `@ant-design/icons@^6`, `zustand@^5.0.14`; add dev dependencies `vite@^8.2.1`, `@vitejs/plugin-react@^6.0.5`, `vitest@^4.1.10`, `jsdom@^30.0.1`, `@testing-library/react@^16.3.2`, `@testing-library/jest-dom`, `@types/react`, `@types/react-dom`.

- [ ] **Step 4: Create separate browser TypeScript and Vite configuration**

Keep `packages/web-tap/tsconfig.json` limited to Node sources and `.test.ts` files. Create `tsconfig.web.json` with:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx", "test/**/*.test.tsx", "vite.config.ts"]
}
```

Configure Vite with React plugin, `build.outDir = "dist"`, `server.host = "127.0.0.1"`, and development proxies for `/api/events` and `/api/events/stream` to `http://127.0.0.1:4319`. Configure Vitest with `environment: "jsdom"`, `include: ["test/web/**/*.test.{ts,tsx}"]`, and a setup file importing `@testing-library/jest-dom/vitest`. This keeps the existing Node `test/*.test.ts` suite out of Vitest.

- [ ] **Step 5: Implement the minimum Ant Design shell**

Use `ConfigProvider`, `App`, and `Layout` in `main.tsx`/`TapApp.tsx`. Render semantic headings for the three regions and empty-state copy. Do not implement data logic yet.

Use Ant Design 6 APIs verified by CLI: `Layout.Sider width`, `Descriptions items`, and `Collapse items`; avoid deprecated `Collapse.Panel` in later tasks.

- [ ] **Step 6: Verify build, typecheck, and smoke test**

Run:

```bash
npm install
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-app.test.tsx
npm run build -w @dkagent/web-tap
npm run typecheck -w @dkagent/web-tap
```

Expected: one passing smoke test, Vite emits `packages/web-tap/dist/index.html` and assets, typecheck exits 0.

- [ ] **Step 7: Commit the buildable shell**

```bash
git add package-lock.json packages/web-tap/package.json packages/web-tap/tsconfig.json packages/web-tap/tsconfig.web.json packages/web-tap/vite.config.ts packages/web-tap/index.html packages/web-tap/src/web packages/web-tap/test/web/tap-app.test.tsx
git commit -m "feat(web-tap): scaffold React viewer"
```

---

### Task 2: 投影 Runtime Events 为 Turn、Step、Node

**Files:**
- Create: `packages/web-tap/src/web/model/types.ts`
- Create: `packages/web-tap/src/web/model/context-diff.ts`
- Create: `packages/web-tap/src/web/model/project-events.ts`
- Create: `packages/web-tap/test/web/project-events.test.ts`

**Interfaces:**
- Consumes: `RuntimeEvent[]` from `@dkagent/agent/runtime-events`.
- Produces: `projectEvents(events): TapSessionView[]`, `createContextDiff(before, after): ContextDiff`, and stable `TapNodeView` IDs.

- [ ] **Step 1: Write failing projection tests with one text Turn and one Tool Turn**

Create fixtures covering:

```ts
const textTurn = [
  event("turn.start", "turn-1", { input: "你好" }),
  event("context.before", "turn-1", beforePayload, 1),
  event("context.after", "turn-1", afterPayload, 1),
  event("model.response", "turn-1", { request, response: textResponse }, 1),
  event("turn.end", "turn-1", { answer: "你好" }, 1),
];
```

Assert that:

- one `turn.start` produces exactly one Turn;
- Turn 1 contains Step 1;
- `model.response` produces adjacent `model_request` and `model_response` nodes;
- a Tool Turn contains Step 1 Tool Call/Result and Step 2 model nodes;
- unknown event types produce a generic `unknown` node with raw JSON.

- [ ] **Step 2: Run the projection test and verify RED**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/project-events.test.ts
```

Expected: FAIL because `projectEvents` and View Model types do not exist.

- [ ] **Step 3: Define stable View Model contracts**

Define:

```ts
export type TapNodeKind =
  | "turn_start" | "context_before" | "context_after"
  | "context_trimmed" | "model_request" | "model_response"
  | "tool_call" | "tool_result" | "turn_end" | "turn_error" | "unknown";

export interface TapNodeView {
  id: string;
  kind: TapNodeKind;
  title: string;
  eventType: string;
  status: "running" | "completed" | "error";
  eventIds: string[];
  detail: unknown;
  rawEvents: RuntimeEvent[];
}
```

Include `TapStepView`, `TapTurnView`, `TapSessionView`, and `ContextDiff`. Node IDs must be deterministic, for example `${turnId}:${step}:${kind}:${sourceEventId}`; the request/response pair may use suffixes `:request` and `:response`.

- [ ] **Step 4: Implement context diff without splitting Tool exchanges**

Reuse the current stable structural comparison idea, but group Assistant Tool Calls with their matching Tool Results before removal. `ContextDiff` must return `before`, `after`, `removedGroups`, `beforeMessageCount`, `afterMessageCount`, and token fields available from the two payloads.

- [ ] **Step 5: Implement projection and derived direct-trim node**

Sort events with existing sequence semantics, group by `sessionId`, then `turnId`, then numeric Step. Put `turn.start` into Step 1 and terminal events into their emitted Step or latest Step. When a matched `context.after.payload.droppedMessageCount > 0`, insert `context_trimmed` between context-before and context-after using both raw events.

Do not emit `context.compaction.*` nodes until Agent runtime actually publishes those events.

- [ ] **Step 6: Verify model tests and immutability**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/project-events.test.ts
npm run typecheck -w @dkagent/web-tap
```

Expected: projection tests pass; input events remain deeply equal to a cloned copy.

- [ ] **Step 7: Commit the projection layer**

```bash
git add packages/web-tap/src/web/model packages/web-tap/test/web/project-events.test.ts
git commit -m "feat(web-tap): project events into loop nodes"
```

---

### Task 3: 建立 Zustand 事件流与选择规则

**Files:**
- Create: `packages/web-tap/src/web/store/tap-store.ts`
- Create: `packages/web-tap/src/web/api/event-feed.ts`
- Create: `packages/web-tap/test/web/tap-store.test.ts`
- Modify: `packages/web-tap/src/web/app/TapApp.tsx`

**Interfaces:**
- Consumes: `mergeViewerEvents(current, incoming)` and `projectEvents(events)`.
- Produces: `createTapStore()`, `useTapStore`, `connectEventFeed(store, options): () => void`.

- [ ] **Step 1: Write failing store tests**

Cover these rules:

```ts
it("selects the latest Turn and latest node on first history load");
it("keeps a manually selected historical Turn when live events arrive");
it("follows the newest node while the user is already following live state");
it("deduplicates an event received from both history and SSE");
it("moves connection state through connecting, live and reconnecting");
```

- [ ] **Step 2: Run the store test and verify RED**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-store.test.ts
```

Expected: FAIL because `createTapStore` is missing.

- [ ] **Step 3: Implement a vanilla Zustand store plus React hook**

Store only:

```ts
interface TapState {
  events: RuntimeEvent[];
  connectionStatus: "connecting" | "live" | "reconnecting" | "error";
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  selectedNodeId: string | null;
  followLive: boolean;
  replaceHistory(events: RuntimeEvent[]): void;
  appendEvent(event: RuntimeEvent): void;
  selectTurn(turnId: string): void;
  selectNode(nodeId: string): void;
  setConnectionStatus(status: TapState["connectionStatus"]): void;
}
```

Derive sessions/turns/nodes through selectors; never store a second copy of projected data.

- [ ] **Step 4: Implement History + EventSource connection**

`connectEventFeed` must:

1. fetch `/api/events` on start and every SSE `open`;
2. merge history with events that arrived during the await window;
3. append parsed `message` events;
4. set `reconnecting` on error;
5. return a cleanup function that closes EventSource and prevents late history writes.

Inject `fetch` and `EventSource` constructors through options so tests do not require a real server.

- [ ] **Step 5: Wire the app lifecycle**

Connect once in a top-level effect and clean up on unmount. Subscribe each component to the smallest Zustand selector needed; do not subscribe the entire app to all events.

- [ ] **Step 6: Verify store and existing reconnect tests**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-store.test.ts
npm run test:node -w @dkagent/web-tap
```

Expected: new store tests pass and existing history/SSE merge tests remain green.

- [ ] **Step 7: Commit the event state layer**

```bash
git add packages/web-tap/src/web/api packages/web-tap/src/web/store packages/web-tap/src/web/app/TapApp.tsx packages/web-tap/test/web/tap-store.test.ts
git commit -m "feat(web-tap): add live event store"
```

---

### Task 4: 实现 Turn / Node / Detail 三栏界面

**Files:**
- Create: `packages/web-tap/src/web/features/turns/TurnList.tsx`
- Create: `packages/web-tap/src/web/features/timeline/NodeNav.tsx`
- Create: `packages/web-tap/src/web/features/node-detail/NodeDetail.tsx`
- Create: `packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx`
- Create: `packages/web-tap/src/web/features/compaction/ContextCompactionDetail.tsx`
- Create: `packages/web-tap/src/web/shared/RawJson.tsx`
- Modify: `packages/web-tap/src/web/app/TapApp.tsx`
- Modify: `packages/web-tap/src/web/styles.css`
- Modify: `packages/web-tap/test/web/tap-app.test.tsx`

**Interfaces:**
- Consumes: selected `TapTurnView`, `TapNodeView`, store actions, `ContextDiff`.
- Produces: accessible three-column Session detail UI and node renderer registry.

- [ ] **Step 1: Expand failing component tests**

Render with injected fixture state and assert:

- three user inputs render as “第 1 轮” through “第 3 轮”;
- clicking 第 2 轮 changes the right heading to “第 2 轮节点”;
- Step 1 and Step 2 grouping labels appear;
- clicking “模型请求” changes the detail title and shows `request` JSON;
- context-trim node shows “裁剪前”, “裁剪后”, and removed messages;
- raw JSON Collapse expands and copy button calls `navigator.clipboard.writeText`;
- no text matching “Session 列表” or breadcrumb separator is rendered.

- [ ] **Step 2: Run the component test and verify RED**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-app.test.tsx
```

Expected: FAIL on missing Turn interaction and detail components.

- [ ] **Step 3: Implement left Turn list**

Use semantic `<button>` items inside an Ant Design `List`. Each item shows index, truncated input, Step count, Tool count, and textual status. Provide visible keyboard focus. Default/latest selection behavior remains in Store, not component-local state.

- [ ] **Step 4: Implement right Step-grouped node navigation**

Render each Step as a heading and each node as a button connected by a neutral vertical line. Pair Tool Call/Result visually with shared `toolCallId`; show current/completed/error with both text/icon and color. Avoid using Ant Design `Steps` if it prevents nested, individually selectable nodes.

- [ ] **Step 5: Implement renderer registry and semantic details**

Map each `TapNodeKind` to a focused renderer. Use Ant Design `Descriptions items` for translated scalar fields, `Card`/`Collapse items` for System/User/Assistant/Tool messages, and `Alert` for errors. Unknown nodes must fall back to raw JSON instead of throwing.

- [ ] **Step 6: Implement context trim detail**

Show trigger reason, token budget, Before/After counts, removed groups, and raw events. Label it “上下文裁剪”; do not label it “历史摘要压缩” unless dedicated runtime events exist.

- [ ] **Step 7: Implement raw JSON and copy**

Use `Collapse items={[{ key: "raw", label: "原始 JSON", children: ... }]}` and a real Button. `JSON.stringify(rawEvents, null, 2)` is the copied content. On clipboard rejection, show an Ant Design message error without crashing the detail panel.

- [ ] **Step 8: Apply restrained responsive styling**

Desktop widths: left 240px, center `minmax(420px, 1fr)`, right 280px. Below 960px, keep Turn list + detail and move node navigation below; below 640px stack all regions. Use Ant Design tokens through `ConfigProvider`, no gradients, no decorative dashboard cards, and respect `prefers-reduced-motion`.

- [ ] **Step 9: Verify UI tests, Ant Design lint, and build**

```bash
npm run test:web -w @dkagent/web-tap -- --run packages/web-tap/test/web/tap-app.test.tsx
antd lint packages/web-tap/src/web --format json
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
```

Expected: component tests/typecheck/build pass; Ant Design lint contains no deprecated API or accessibility errors in changed files.

- [ ] **Step 10: Commit the Session detail UI**

```bash
git add packages/web-tap/src/web packages/web-tap/test/web/tap-app.test.tsx
git commit -m "feat(web-tap): build loop detail interface"
```

---

### Task 5: 让 TapServer 托管 Vite 构建并完成端到端验收

**Files:**
- Modify: `packages/web-tap/src/tap/server.ts`
- Modify: `packages/web-tap/src/observe.ts`
- Delete: `packages/web-tap/src/tap/viewer.ts`
- Modify: `packages/web-tap/test/server.test.ts`
- Modify: `packages/web-tap/test/observe.test.ts`

**Interfaces:**
- Consumes: Vite output root passed as `startTapServer({ recorder, webRoot })`.
- Produces: safe static routes for `/`, `/assets/*`, existing JSON/SSE APIs, and unchanged `TapServerHandle`.

- [ ] **Step 1: Write failing static-serving tests**

Create a temporary web root containing `index.html` and `assets/app.js`. Assert:

- `/` returns the index with `text/html; charset=utf-8`;
- `/assets/app.js` returns JavaScript content type;
- `/api/events` and `/api/events/stream` still work;
- `/../package.json` and encoded traversal return 404;
- a missing asset returns 404, not the SPA index;
- startup without a readable `webRoot/index.html` rejects and unsubscribes Recorder so observe can fall back to Agent-only mode.

- [ ] **Step 2: Run server tests and verify RED**

```bash
npm run test:node -w @dkagent/web-tap
```

Expected: FAIL because `startTapServer` does not accept or serve `webRoot`.

- [ ] **Step 3: Implement secure static serving**

Extend options with `webRoot: string`. Resolve URL paths against `webRoot`, reject traversal after `decodeURIComponent`, only serve regular files, set explicit content types for html/js/css/json/svg/png/ico, and keep API routes ahead of static handling. Do not expose arbitrary repository files.

- [ ] **Step 4: Point observe at the package dist directory**

Resolve `packages/web-tap/dist` from `import.meta.url`, not `process.cwd()`. Keep Trace at repository-root `.traces/events.jsonl`. Because `observe` runs `npm run build` first, missing/corrupt dist is an observer startup failure and must preserve the existing Agent-only fallback.

- [ ] **Step 5: Remove embedded Viewer**

Delete `src/tap/viewer.ts` and all imports/assertions tied to `VIEWER_HTML`. Keep `viewer-state.ts` only if the browser event client still imports its pure merge helper; otherwise move the helper to the web model/api area and update tests in the same commit.

- [ ] **Step 6: Run package-level regression**

```bash
npm run typecheck -w @dkagent/web-tap
npm test -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
git diff --check
```

Expected: all web-tap tests pass, dist builds, diff check exits 0.

- [ ] **Step 7: Run a real observe smoke test**

Start:

```bash
LLM_API_KEY=dummy LLM_MODEL_ID=dummy npm run observe
```

Verify in another terminal:

```bash
curl --fail --silent http://127.0.0.1:4319/ | rg '<div id="root"></div>'
curl --fail --silent http://127.0.0.1:4319/api/events | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(Array.isArray(JSON.parse(s))))'
```

Expected: root returns Vite index and API prints `true`. Stop with Ctrl+C.

- [ ] **Step 8: Perform browser acceptance with Playwright**

Using a fixture JSONL or a real dummy trace, verify at desktop and mobile widths:

- Turn selection updates node groups;
- node selection updates translated detail and raw JSON;
- context trim detail shows Before/After;
- connection status becomes live;
- no horizontal clipping at 390px;
- keyboard Tab reaches Turn and Node buttons with visible focus.

Capture one desktop screenshot for visual review; do not commit generated screenshots unless explicitly requested.

- [ ] **Step 9: Run scoped and root verification honestly**

```bash
npm test -w @dkagent/web-tap
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
npm test
npm run typecheck
git status --short
```

Expected scoped result: web-tap commands pass. Root commands may still report the already-known Agent System Prompt assertion and pre-existing Agent type errors; compare exact failures with the baseline and do not claim full-project green unless they actually pass.

- [ ] **Step 10: Commit the server integration**

Stage only Tap V2 files. Do not stage Context Compressor files or `.superpowers/` browser drafts.

```bash
git add packages/web-tap package-lock.json
git commit -m "feat(web-tap): serve React session detail"
```

---

## Final Review Checklist

- [ ] `git diff main...HEAD -- packages/agent` shows no Tap V2 dependency added to Agent Core.
- [ ] Left column groups by `turnId`, never by Step.
- [ ] Right column groups nodes by Step within the selected Turn.
- [ ] Model request and response are separately inspectable.
- [ ] Direct context trim is evidence-derived from Before/After and not mislabeled as summary compaction.
- [ ] Every node exposes original JSON.
- [ ] Unknown future events degrade to a generic node.
- [ ] Session list, breadcrumb, web chat controls, provider rankings, and editing controls are absent.
- [ ] Existing dirty Context Compressor files remain unstaged and unchanged by Tap V2 commits.
