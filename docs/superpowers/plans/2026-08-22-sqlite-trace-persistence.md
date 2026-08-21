# SQLite Trace Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist sanitized DKAgent Trace events in the Session SQLite database and provide a read-only CLI that lets Codex reconstruct a specific Agent turn after restart.

**Architecture:** Keep `AgentLoop → Tracer → TraceStore` unchanged. Store every existing `TraceEvent` as one SQLite row and reconstruct logical spans at query time by grouping lifecycle events with the same `spanId`. Web Tap reads historical Trace through bounded reader methods instead of filtering an in-memory global list.

**Tech Stack:** TypeScript 7, Node.js ESM, `better-sqlite3`, Node test runner, HTTP/SSE Web Tap.

## Global Constraints

- Use `.dkagent/sessions.db`; add one `trace_events` table, not another database.
- `trace_events.session_id` references `sessions.id` with `ON DELETE CASCADE`.
- Retain raw Trace events for exactly 30 days; cleanup runs when the writable Store starts.
- Persist complete sanitized content; API Key, Authorization, Headers, environment values, and recalled Memory source text must not reach SQLite.
- `sequence` orders events inside one Trace only; use `timestamp` plus `id` across Traces.
- Agent Core must not import SQLite, Web Tap, query CLI, or persistence-specific types.
- Trace failures must not change the Agent answer; SSE receives an event only after a successful insert.
- Query CLI is read-only, parameterized, and accepts no arbitrary SQL.
- Use synchronous prepared inserts in v1; do not add batching, OpenTelemetry, remote export, or Span projection tables.
- Execute in an isolated worktree because the current main worktree contains unrelated user-owned changes.

---

## File Map

**Create:**

- `packages/trace/src/turn-summary.ts` — derive recent Turn summaries.
- `packages/trace/src/trace-tree.ts` — group raw lifecycle events into a Span tree.
- `packages/trace/src/sqlite-queries.ts` — shared parameterized reads and row decoding.
- `packages/trace/src/sqlite-reader.ts` — read-only reader for the CLI.
- `packages/trace/src/sqlite-store.ts` — writes, retention, subscriptions, failure reporting.
- `packages/trace/src/cli.ts` — `recent`, `show`, `errors` commands.
- `packages/trace/test/reader.test.ts`
- `packages/trace/test/sqlite-store.test.ts`
- `packages/trace/test/trace-tree.test.ts`
- `packages/trace/test/cli.test.ts`
- `packages/web-tap/test/trace-persistence.integration.test.ts`

**Modify:**

- `packages/trace/src/types.ts`, `memory-store.ts`, `index.ts`
- `packages/trace/package.json`, root `package.json`, `package-lock.json`
- `packages/web-tap/src/tap/session-reader.ts`, `tap/server.ts`, `observe.ts`
- `packages/web-tap/test/session-reader.test.ts`, `server.test.ts`, `observe.test.ts`
- `packages/web-tap/WEB-TAP.md`

---

### Task 1: Bounded Trace Reader Contract

**Files:**
- Create: `packages/trace/src/turn-summary.ts`
- Create: `packages/trace/test/reader.test.ts`
- Modify: `packages/trace/src/types.ts`
- Modify: `packages/trace/src/memory-store.ts`
- Modify: `packages/trace/src/index.ts`

**Interfaces:**
- Produces: `TraceReader`, `TraceTurnSummary`, `summarizeRecentTurns(events, limit)`.
- Produces on `MemoryTraceStore`: `listBySession`, `listByTrace`, `listRecentTurns`.

- [ ] **Step 1: Write failing reader tests**

Create two Sessions and two Traces. Assert exact filtering and summary output:

```ts
assert.deepEqual(store.listBySession("session-1").map(({ id }) => id), ["a", "b"]);
assert.deepEqual(store.listByTrace("trace-2").map(({ id }) => id), ["c", "d"]);
assert.deepEqual(store.listRecentTurns(1), [{
  traceId: "trace-2",
  sessionId: "session-2",
  startedAt: "2026-08-22T10:00:00.000Z",
  durationMs: 24,
  status: "completed",
  inputPreview: "第二次问题",
  stepCount: 2,
  modelCallCount: 2,
  toolCallCount: 1,
}]);
```

Also assert an `agent.turn/start` without terminal is `incomplete`, and `agent.turn/error` is `error`.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test packages/trace/test/reader.test.ts`.

Expected: FAIL because bounded reader methods do not exist.

- [ ] **Step 3: Add exact public contracts**

```ts
export type TraceTurnStatus = "completed" | "error" | "incomplete";

export interface TraceTurnSummary {
  traceId: string;
  sessionId?: string;
  startedAt: string;
  durationMs?: number;
  status: TraceTurnStatus;
  inputPreview: string;
  stepCount: number;
  modelCallCount: number;
  toolCallCount: number;
}

export interface TraceReader {
  list(): TraceEvent[];
  listBySession(sessionId: string): TraceEvent[];
  listByTrace(traceId: string): TraceEvent[];
  listRecentTurns(limit: number): TraceTurnSummary[];
}

export interface TraceStore extends TraceSink, TraceReader {
  subscribe(listener: TraceListener): () => void;
}
```

- [ ] **Step 4: Implement summary rules and Memory Store parity**

`summarizeRecentTurns` must:

- reject non-positive/non-integer limits with `limit 必须是正整数`;
- select `agent.turn/start` roots, newest timestamp then `id` first;
- count only `agent.step`, `model.request`, `tool.call` with phase `start`;
- read preview from `start.data.input.input`, otherwise `无法读取输入`;
- derive duration/status from root `end/error`, otherwise mark `incomplete`.

Memory Store filters copies and sorts a Trace by `sequence`, timestamp, then insertion order.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx tsx --test packages/trace/test/*.test.ts
npm run typecheck -w @dkagent/trace
git add packages/trace/src/types.ts packages/trace/src/turn-summary.ts packages/trace/src/memory-store.ts packages/trace/src/index.ts packages/trace/test/reader.test.ts
git commit -m "feat(trace): add bounded trace reader contract"
```

Expected: tests PASS, typecheck exits 0, commit contains only Task 1 files.

---

### Task 2: SQLite Trace Persistence

**Files:**
- Create: `packages/trace/src/sqlite-queries.ts`
- Create: `packages/trace/src/sqlite-reader.ts`
- Create: `packages/trace/src/sqlite-store.ts`
- Create: `packages/trace/test/sqlite-store.test.ts`
- Modify: `packages/trace/src/index.ts`
- Modify: `packages/trace/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Task 1 reader contracts and summary helper.
- Produces: `SqliteTraceReader`, `SqliteTraceStore`, `SqliteTraceStoreOptions`.

- [ ] **Step 1: Add dependency and failing tests**

Add `"better-sqlite3": "^13.0.3"` to `@dkagent/trace` dependencies and run `npm install`.

In tests, prepare the required parent table before constructing the Trace Store:

```ts
function createSessionDatabase(path: string): void {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  database.prepare(`INSERT INTO sessions VALUES (?, ?, ?)`)
    .run("session-1", NOW, NOW);
  database.close();
}
```

Test these exact cases:

1. Emit, close, reopen read-only, and deep-equal the event.
2. Secrets and `<recalled_memory>` text are absent from raw database bytes.
3. Bounded methods return only requested Session/Trace.
4. Subscriber runs only after a second connection can read the row.
5. A 31-day event is removed at startup; a 29-day event remains.
6. Missing Session makes `emit` throw; repeated failures call `onWriteError` once, success resets it, then a new failure calls it again.
7. Reader connection rejects writes.
8. On non-Windows, new database mode satisfies `(mode & 0o077) === 0`.

Run `npx tsx --test packages/trace/test/sqlite-store.test.ts`.

Expected: FAIL because Store/Reader exports do not exist.

- [ ] **Step 2: Implement the row codec and bound queries**

Use this persisted row shape:

```ts
interface TraceEventRow {
  id: string;
  session_id: string;
  trace_id: string;
  span_id: string | null;
  parent_span_id: string | null;
  sequence: number;
  timestamp: string;
  duration_ms: number | null;
  name: string;
  phase: string;
  step: number | null;
  module: string | null;
  operation: string | null;
  schema_version: number;
  data_json: string;
}
```

`decodeTraceEvent` rejects versions other than `1`, parses `data_json`, and restores optional fields only for non-null values. Use parameterized reads:

```sql
SELECT * FROM trace_events
WHERE session_id = ?
ORDER BY timestamp ASC, sequence ASC, id ASC
```

```sql
SELECT * FROM trace_events
WHERE trace_id = ?
ORDER BY sequence ASC, timestamp ASC, id ASC
```

Recent Turns query only recent `agent.turn/start` roots with `LIMIT ?`, then loads those Traces and uses `summarizeRecentTurns`.

- [ ] **Step 3: Implement the read-only reader**

Open with:

```ts
new Database(databasePath, { readonly: true, fileMustExist: true });
```

Expose only `list`, bounded reader methods, and `close`; expose no Database handle or SQL method.

- [ ] **Step 4: Implement the writable Store**

```ts
export interface SqliteTraceStoreOptions {
  now?: () => Date;
  onWriteError?: (error: unknown) => void;
}
```

Construction order:

1. Create parent directory unless `:memory:`.
2. Enable `foreign_keys = ON` and `journal_mode = WAL`.
3. Create this exact table and indexes:

```sql
CREATE TABLE IF NOT EXISTS trace_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_span_id TEXT,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER,
  name TEXT NOT NULL,
  phase TEXT NOT NULL,
  step INTEGER,
  module TEXT,
  operation TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_events_session_order
  ON trace_events(session_id, timestamp, sequence);
CREATE INDEX IF NOT EXISTS idx_trace_events_trace_order
  ON trace_events(trace_id, sequence);
CREATE INDEX IF NOT EXISTS idx_trace_events_retention
  ON trace_events(timestamp);
```

4. Delete `timestamp < now - 30 days` with an ISO bound parameter.
5. Restrict file to `0o600`.
6. Prepare one insert statement.

Write path:

```ts
const sanitized = sanitizeTraceEvent(event);
try {
  insert.run(/* columns plus JSON.stringify(sanitized.data) */);
  writeFailureActive = false;
  notifySubscribers(sanitized);
} catch (error: unknown) {
  if (!writeFailureActive) options.onWriteError?.(error);
  writeFailureActive = true;
  throw error;
}
```

`close()` checkpoints WAL, clears listeners, and closes the connection.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx tsx --test packages/trace/test/sqlite-store.test.ts
npm test -w @dkagent/trace
npm run typecheck -w @dkagent/trace
git add packages/trace/package.json package-lock.json packages/trace/src/sqlite-queries.ts packages/trace/src/sqlite-reader.ts packages/trace/src/sqlite-store.ts packages/trace/src/index.ts packages/trace/test/sqlite-store.test.ts
git commit -m "feat(trace): persist sanitized events in sqlite"
```

Expected: all commands exit 0.

---

### Task 3: Codex Read-Only Query CLI

**Files:**
- Create: `packages/trace/src/trace-tree.ts`
- Create: `packages/trace/src/cli.ts`
- Create: `packages/trace/test/trace-tree.test.ts`
- Create: `packages/trace/test/cli.test.ts`
- Modify: `packages/trace/src/index.ts`
- Modify: `packages/trace/package.json`
- Modify: root `package.json`

**Interfaces:**
- Consumes: `SqliteTraceReader`, `TraceEvent`, `TraceTurnSummary`.
- Produces: `buildTraceTree(events): TraceTreeResult` and root `npm run trace -- ...`.

- [ ] **Step 1: Write failing tree tests**

Assert a root Turn contains an Agent Step, Model Span, internal model response event, and Tool Span. Add missing terminal, duplicate start, duplicate terminal, and missing parent cases with stable codes:

```ts
type TraceTreeIssueCode =
  | "missing_terminal"
  | "duplicate_start"
  | "duplicate_terminal"
  | "missing_parent";
```

Run `npx tsx --test packages/trace/test/trace-tree.test.ts`.

Expected: FAIL because `buildTraceTree` does not exist.

- [ ] **Step 2: Implement lossless tree projection**

```ts
export interface TraceTreeNode {
  spanId: string;
  parentSpanId?: string;
  name: TraceEventName;
  step?: number;
  status: "running" | "completed" | "error";
  startedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  events: TraceEvent[];
  children: TraceTreeNode[];
}

export interface TraceTreeResult {
  roots: TraceTreeNode[];
  issues: Array<{ code: TraceTreeIssueCode; spanId: string }>;
}
```

Group by `spanId`; lifecycle phases populate the node, phase `event` remains lossless in `events`. Link by `parentSpanId`, sort by original `sequence`, and never discard unknown payloads.

- [ ] **Step 3: Write failing CLI tests**

Seed a temporary database and spawn:

```bash
npx tsx packages/trace/src/cli.ts recent --limit 10 --database <path> --json
npx tsx packages/trace/src/cli.ts show trace-1 --database <path> --json
npx tsx packages/trace/src/cli.ts errors --session session-1 --database <path> --json
```

Assert exact JSON shapes, only requested errors, non-zero exit for malformed arguments/missing Trace, Chinese usage text, and unchanged database bytes plus modification time.

Run `npx tsx --test packages/trace/test/cli.test.ts`.

Expected: FAIL because the CLI does not exist.

- [ ] **Step 4: Implement strict read-only commands**

Accept only:

```text
recent [--limit N] [--database PATH] [--json]
show TRACE_ID [--database PATH] [--json]
errors --session SESSION_ID [--database PATH] [--json]
```

Default database is `.dkagent/sessions.db`. `show --json` returns `{ traceId, events, tree, issues }`. Text mode prints an indented tree and ends in `轨迹完整` or `轨迹可能不完整：<codes>`. JSON uses `JSON.stringify(value, null, 2)` with no ANSI codes.

Add scripts:

```json
// packages/trace/package.json
"trace": "cd ../.. && tsx packages/trace/src/cli.ts"
```

```json
// root package.json
"trace": "npm run trace -w @dkagent/trace --"
```

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx tsx --test packages/trace/test/trace-tree.test.ts packages/trace/test/cli.test.ts
npm test -w @dkagent/trace
npm run typecheck -w @dkagent/trace
git add package.json packages/trace/package.json packages/trace/src/trace-tree.ts packages/trace/src/cli.ts packages/trace/src/index.ts packages/trace/test/trace-tree.test.ts packages/trace/test/cli.test.ts
git commit -m "feat(trace): add readonly trace query cli"
```

Expected: all commands exit 0.

---

### Task 4: Session Lifecycle and Web Tap Integration

**Files:**
- Create: `packages/web-tap/test/trace-persistence.integration.test.ts`
- Modify: `packages/web-tap/src/tap/session-reader.ts`
- Modify: `packages/web-tap/src/tap/server.ts`
- Modify: `packages/web-tap/src/observe.ts`
- Modify: `packages/web-tap/test/session-reader.test.ts`
- Modify: `packages/web-tap/test/server.test.ts`
- Modify: `packages/web-tap/test/observe.test.ts`

**Interfaces:**
- Consumes: `TraceReader`, `TraceStore`, `SqliteTraceStore`, `Tracer`, `SqliteSessionStore`.
- Preserves: existing HTTP URLs and SSE payloads.

- [ ] **Step 1: Write failing bounded-read tests**

Use a fake whose `list()` throws and whose `listBySession` is observable:

```ts
const traces = {
  list: () => { throw new Error("不应全量读取"); },
  listBySession: vi.fn((id: string) => id === "session-1" ? [event] : []),
  listByTrace: () => [],
  listRecentTurns: () => [],
  emit: () => undefined,
  subscribe: () => () => undefined,
};
```

Assert Session list `hasTrace` and `/api/sessions/:id/events` use `listBySession`. `/api/events` may retain `list()` only as a compatibility endpoint.

- [ ] **Step 2: Write failing persistence integration tests**

1. Open `SqliteSessionStore`, then `SqliteTraceStore`, on one temp database.
2. Create two Sessions and persist a complete Turn for each.
3. Close/reopen; assert HTTP returns historical events.
4. Delete one Session; assert its Trace disappears and the other remains.

Run:

```bash
npx tsx --test packages/web-tap/test/session-reader.test.ts packages/web-tap/test/server.test.ts packages/web-tap/test/trace-persistence.integration.test.ts
```

Expected: FAIL because Web Tap still filters full in-memory history.

- [ ] **Step 3: Switch Web Tap to bounded reads**

Change Session `hasTrace` to:

```ts
hasTrace: traces.listBySession(summary.id).length > 0
```

Change the Session events endpoint to:

```ts
store.listBySession(sessionId)
```

- [ ] **Step 4: Compose persistence independently from Viewer health**

In `observe.ts`:

1. Create `SqliteSessionStore(".dkagent/sessions.db")` first.
2. Create `SqliteTraceStore` on the same path with a throttled `onWriteError` warning.
3. Inject `Tracer(traceStore)` into `runAgentCli`.
4. If Tap Server startup fails, continue `runAgentCli({ tracer, sessionStore })`; persistence stays enabled.
5. In `finally`, close Server if started, then Trace Store, then Session Store, attempting every close.
6. If Trace Store construction fails, warn once and run Agent with Session Store plus no-sink `Tracer`; do not claim persistence is active.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx tsx --test packages/web-tap/test/session-reader.test.ts packages/web-tap/test/server.test.ts packages/web-tap/test/trace-persistence.integration.test.ts packages/web-tap/test/observe.test.ts
npm run typecheck -w @dkagent/web-tap
git add packages/web-tap/src/tap/session-reader.ts packages/web-tap/src/tap/server.ts packages/web-tap/src/observe.ts packages/web-tap/test/session-reader.test.ts packages/web-tap/test/server.test.ts packages/web-tap/test/observe.test.ts packages/web-tap/test/trace-persistence.integration.test.ts
git commit -m "feat(web-tap): load persisted session traces"
```

Expected: tests PASS and typecheck exits 0.

---

### Task 5: Documentation and End-to-End Verification

**Files:**
- Modify: `packages/web-tap/WEB-TAP.md`

**Interfaces:**
- Consumes: final behavior from Tasks 1–4.
- Produces: discoverable instructions for Codex and humans.

- [ ] **Step 1: Document the exact workflow**

Add:

```bash
npm run trace -- recent --limit 10
npm run trace -- show <traceId>
npm run trace -- errors --session <sessionId>
```

State: 30-day retention, Session cascade deletion, historical empty state, complete local content after current redaction, and read-only JSON mode for Codex.

- [ ] **Step 2: Run complete scoped verification**

```bash
npm test -w @dkagent/trace
npm run typecheck -w @dkagent/trace
npm test -w @dkagent/web-tap
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
npm run test:session -w @dkagent/agent
npm run typecheck:session -w @dkagent/agent
```

Expected: every command exits 0. If an unrelated baseline fails, record the exact failure and prove focused persistence tests pass; do not claim the full suite passes.

- [ ] **Step 3: Perform one real smoke trace**

Run `npm run observe`, complete one harmless Turn, stop, then run:

```bash
npm run trace -- recent --limit 1 --json
npm run trace -- show <returned-trace-id> --json
```

Verify the Turn survives restart, has one root `agent.turn`, contains its Steps/model/Tool calls, has no issues, and exposes no known `.env` secret. Do not commit `.dkagent/` artifacts.

- [ ] **Step 4: Commit docs and inspect scope**

```bash
git add packages/web-tap/WEB-TAP.md
git commit -m "docs: document persistent trace workflow"
git diff --check HEAD~4..HEAD
git status --short
git log -5 --oneline
```

Confirm every changed line maps to persistence, bounded reading, Codex querying, safety, or verification; leave unrelated changes untouched.
