# DKAgent Session MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DKAgent 在程序重启后自动恢复最近一次普通对话和 Context 压缩状态，并支持 `/new` 创建空白 Session。

**Architecture:** 使用 SQLite 保存两类数据：`session_messages` 追加保存完整消息事实，`sessions` 覆盖保存当前 Context 压缩快照。AgentLoop 只依赖 `SessionStore` 接口；CLI 负责加载最近 Session 或创建新 Session。

**Tech Stack:** TypeScript、Node.js、better-sqlite3、node:test、tsx。

## Global Constraints

- 只实现普通对话 Session，不实现 Memory、状态机、Checkpoint、回滚、分支、事件回放和面试诊断进度。
- 原始消息只能追加，不能覆盖或删除。
- Context 压缩状态允许覆盖保存。
- 启动时恢复最近 Session；输入 `/new` 创建新 Session。
- 所有新增类型属性必须有中文注释。
- 不修复当前全包 typecheck 中既有的 Skill/Tool 错误，使用 Session 专用验证命令。

## File Map

- Create `packages/agent/src/session/types.ts`：Session 快照和持久化端口。
- Create `packages/agent/src/session/store.ts`：SQLite 表结构、创建、恢复和写入。
- Create `packages/agent/src/session/index.ts`：Session 模块出口。
- Create `packages/agent/test/session/store.test.ts`：SQLite Store 行为测试。
- Create `packages/agent/test/session/agent-loop-session.test.ts`：AgentLoop 恢复和持久化测试。
- Create `packages/agent/tsconfig.session.json`：Session 范围类型检查。
- Modify `packages/agent/src/agent/types.ts`：给 AgentLoop 注入可选 Session。
- Modify `packages/agent/src/agent/loop.ts`：从快照恢复并持久化每次状态变化。
- Modify `packages/agent/src/cli/run.ts`：启动恢复最近 Session，处理 `/new`。
- Modify `packages/agent/package.json`：增加 `test:session` 和 `typecheck:session`。

---

### Task 1: SQLite SessionStore

**Files:**
- Create: `packages/agent/src/session/types.ts`
- Create: `packages/agent/src/session/store.ts`
- Create: `packages/agent/src/session/index.ts`
- Create: `packages/agent/test/session/store.test.ts`
- Create: `packages/agent/tsconfig.session.json`
- Modify: `packages/agent/package.json`

**Interfaces:**
- Consumes: `AgentMessage`、`ConversationContextState`。
- Produces: `SessionSnapshot`、`SessionStore`、`SqliteSessionStore`。

- [ ] **Step 1: 编写 SessionStore 失败测试**

创建 `packages/agent/test/session/store.test.ts`：

```typescript
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "../../src/session/store.js";

test("关闭数据库后仍能恢复最近 Session 的消息和 Context 状态", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const databasePath = join(directory, "sessions.db");
    const firstStore = new SqliteSessionStore(databasePath);
    const session = firstStore.create();

    firstStore.appendMessage(session.id, { role: "user", content: "第一轮问题" });
    firstStore.appendMessage(session.id, {
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "demo", input: { value: 1 } }],
    });
    firstStore.appendMessage(session.id, {
        role: "tool",
        toolCallId: "call-1",
        content: "{\"ok\":true}",
    });
    firstStore.saveContextState(session.id, {
        summary: "已经讨论第一轮问题",
        firstKeptMessageIndex: 1,
    });
    firstStore.close();

    const secondStore = new SqliteSessionStore(databasePath);
    const restored = secondStore.loadLatest();

    assert.equal(restored?.id, session.id);
    assert.deepEqual(restored?.messages, [
        { role: "user", content: "第一轮问题" },
        {
            role: "assistant",
            toolCalls: [{ id: "call-1", name: "demo", input: { value: 1 } }],
        },
        { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
    ]);
    assert.deepEqual(restored?.contextState, {
        summary: "已经讨论第一轮问题",
        firstKeptMessageIndex: 1,
    });
    secondStore.close();
});

test("创建新 Session 后最近 Session 为空且旧消息仍保留", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const store = new SqliteSessionStore(join(directory, "sessions.db"));
    const oldSession = store.create();
    store.appendMessage(oldSession.id, { role: "user", content: "旧问题" });

    const newSession = store.create();
    const latest = store.loadLatest();

    assert.equal(latest?.id, newSession.id);
    assert.deepEqual(latest?.messages, []);
    assert.notEqual(newSession.id, oldSession.id);
    store.close();
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
npx tsx --test packages/agent/test/session/store.test.ts
```

Expected: FAIL，错误包含 `Cannot find module '../../src/session/store.js'`。

- [ ] **Step 3: 定义 Session 类型**

创建 `packages/agent/src/session/types.ts`：

```typescript
import type { ConversationContextState } from "../context/types.js";
import type { AgentMessage } from "../query-engine/provider.js";

/** 一次可跨进程恢复的普通对话快照。 */
export interface SessionSnapshot {
    /** Session 唯一标识。 */
    id: string;
    /** AgentLoop 保存的完整原始消息。 */
    messages: AgentMessage[];
    /** ContextManager 增量压缩所需的最新状态。 */
    contextState: ConversationContextState;
    /** Session 创建时间。 */
    createdAt: string;
    /** Session 最近一次持久化更新时间。 */
    updatedAt: string;
}

/** AgentLoop 与 CLI 使用的最小 Session 持久化端口。 */
export interface SessionStore {
    /** 创建并返回一个空 Session。 */
    create(): SessionSnapshot;
    /** 加载最近更新的 Session；不存在时返回 null。 */
    loadLatest(): SessionSnapshot | null;
    /** 向指定 Session 追加一条完整消息。 */
    appendMessage(sessionId: string, message: AgentMessage): void;
    /** 覆盖保存指定 Session 的最新 Context 压缩状态。 */
    saveContextState(sessionId: string, state: ConversationContextState): void;
}
```

- [ ] **Step 4: 实现 SQLite Store**

创建 `packages/agent/src/session/store.ts`：

```typescript
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { ConversationContextState } from "../context/types.js";
import type { AgentMessage } from "../query-engine/provider.js";
import type { SessionSnapshot, SessionStore } from "./types.js";

interface SessionRow {
    id: string;
    summary: string;
    first_kept_message_index: number;
    created_at: string;
    updated_at: string;
}

interface MessageRow {
    message_json: string;
}

/** 使用 SQLite 持久化普通对话消息和 Context 压缩状态。 */
export class SqliteSessionStore implements SessionStore {
    private readonly database: Database.Database;

    public constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
        }
        this.database = new Database(databasePath);
        this.database.pragma("foreign_keys = ON");
        this.database.pragma("journal_mode = WAL");
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                first_kept_message_index INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                message_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_session
                ON session_messages(session_id, id);
        `);
    }

    public create(): SessionSnapshot {
        const timestamp = new Date().toISOString();
        const snapshot: SessionSnapshot = {
            id: randomUUID(),
            messages: [],
            contextState: { summary: "", firstKeptMessageIndex: 0 },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.database.prepare(`
            INSERT INTO sessions (id, summary, first_kept_message_index, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(snapshot.id, "", 0, timestamp, timestamp);
        return snapshot;
    }

    public loadLatest(): SessionSnapshot | null {
        const row = this.database.prepare(`
            SELECT id, summary, first_kept_message_index, created_at, updated_at
            FROM sessions
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
        `).get() as SessionRow | undefined;
        if (!row) return null;

        const messageRows = this.database.prepare(`
            SELECT message_json
            FROM session_messages
            WHERE session_id = ?
            ORDER BY id ASC
        `).all(row.id) as MessageRow[];

        let messages: AgentMessage[];
        try {
            messages = messageRows.map((messageRow) =>
                JSON.parse(messageRow.message_json) as AgentMessage,
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Session ${row.id} 消息数据损坏：${message}`);
        }

        return {
            id: row.id,
            messages,
            contextState: {
                summary: row.summary,
                firstKeptMessageIndex: row.first_kept_message_index,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    public appendMessage(sessionId: string, message: AgentMessage): void {
        const timestamp = new Date().toISOString();
        const write = this.database.transaction(() => {
            const result = this.database.prepare(`
                INSERT INTO session_messages (session_id, message_json, created_at)
                VALUES (?, ?, ?)
            `).run(sessionId, JSON.stringify(message), timestamp);
            if (result.changes !== 1) {
                throw new Error(`Session ${sessionId} 消息写入失败`);
            }
            this.touch(sessionId, timestamp);
        });
        write();
    }

    public saveContextState(sessionId: string, state: ConversationContextState): void {
        const result = this.database.prepare(`
            UPDATE sessions
            SET summary = ?, first_kept_message_index = ?, updated_at = ?
            WHERE id = ?
        `).run(
            state.summary,
            state.firstKeptMessageIndex,
            new Date().toISOString(),
            sessionId,
        );
        if (result.changes !== 1) {
            throw new Error(`Session ${sessionId} 不存在`);
        }
    }

    public close(): void {
        this.database.close();
    }

    private touch(sessionId: string, timestamp: string): void {
        const result = this.database.prepare(`
            UPDATE sessions SET updated_at = ? WHERE id = ?
        `).run(timestamp, sessionId);
        if (result.changes !== 1) {
            throw new Error(`Session ${sessionId} 不存在`);
        }
    }
}
```

- [ ] **Step 5: 增加模块出口和 Session 专用验证配置**

创建 `packages/agent/src/session/index.ts`：

```typescript
export { SqliteSessionStore } from "./store.js";
export type { SessionSnapshot, SessionStore } from "./types.js";
```

创建 `packages/agent/tsconfig.session.json`：

```json
{
  "extends": "./tsconfig.json",
  "include": [
    "src/agent/dispatcher.ts",
    "src/agent/loop.ts",
    "src/agent/types.ts",
    "src/context/**/*.ts",
    "src/query-engine/**/*.ts",
    "src/session/**/*.ts",
    "src/tools/registry.ts",
    "src/tools/types.ts",
    "test/session/**/*.test.ts"
  ]
}
```

在 `packages/agent/package.json` 的 scripts 中增加：

```json
"test:session": "cd ../.. && tsx --test packages/agent/test/session/*.test.ts",
"typecheck:session": "tsc -p tsconfig.session.json --noEmit"
```

- [ ] **Step 6: 运行 Store 测试和类型检查**

Run:

```bash
npm run test:session --workspace @dkagent/agent
npm run typecheck:session --workspace @dkagent/agent
```

Expected: 两个 Store 测试 PASS；Session 范围 TypeScript 检查退出码为 0。

- [ ] **Step 7: 提交 Store**

```bash
git add packages/agent/src/session packages/agent/test/session/store.test.ts packages/agent/tsconfig.session.json packages/agent/package.json
git commit -m "feat(session): add sqlite session store"
```

---

### Task 2: AgentLoop 恢复与增量持久化

**Files:**
- Modify: `packages/agent/src/agent/types.ts`
- Modify: `packages/agent/src/agent/loop.ts`
- Create: `packages/agent/test/session/agent-loop-session.test.ts`

**Interfaces:**
- Consumes: `SessionSnapshot`、`SessionStore`。
- Produces: 可从 Session 快照初始化、并在每次消息和压缩状态变化时同步 Store 的 `AgentLoop`。

- [ ] **Step 1: 编写 AgentLoop Session 失败测试**

创建 `packages/agent/test/session/agent-loop-session.test.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop.js";
import type {
    ContextBuilder,
    ContextBuildInput,
    ContextSnapshot,
    ConversationContextState,
} from "../../src/context/types.js";
import type {
    LLMProvider,
    StreamEvent,
    StreamParams,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import type { SessionSnapshot, SessionStore } from "../../src/session/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

class FakeProvider implements LLMProvider {
    public readonly name = "fake";
    public readonly requests: StreamParams[] = [];

    public constructor(private readonly responses: StreamEvent[][]) {}

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        const response = this.responses.shift();
        if (!response) throw new Error("FakeProvider 没有可用响应");
        for (const event of response) yield event;
    }

    public async countTokens(): Promise<number> {
        return 0;
    }
}

class RecordingSessionStore implements SessionStore {
    public readonly appendedMessages: SessionSnapshot["messages"] = [];
    public readonly savedStates: ConversationContextState[] = [];

    public constructor(public readonly snapshot: SessionSnapshot) {}

    public create(): SessionSnapshot {
        return this.snapshot;
    }

    public loadLatest(): SessionSnapshot {
        return this.snapshot;
    }

    public appendMessage(_sessionId: string, message: SessionSnapshot["messages"][number]): void {
        this.appendedMessages.push(structuredClone(message));
    }

    public saveContextState(_sessionId: string, state: ConversationContextState): void {
        this.savedStates.push({ ...state });
    }
}

const passthroughContextBuilder: ContextBuilder = {
    async build(input: ContextBuildInput): Promise<ContextSnapshot> {
        return {
            messages: [...input.messages],
            tools: [...input.tools],
        };
    },
};

const usage = { inputTokens: 1, outputTokens: 1 };

function textResponse(content: string): StreamEvent[] {
    return [
        { type: "text_delta", content },
        { type: "message_end", usage, stopReason: "end_turn" },
    ];
}

function emptySnapshot(id: string): SessionSnapshot {
    const timestamp = "2026-08-14T00:00:00.000Z";
    return {
        id,
        messages: [],
        contextState: { summary: "", firstKeptMessageIndex: 0 },
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function createSessionAgent(
    provider: FakeProvider,
    store: RecordingSessionStore,
    contextManager: ContextBuilder = passthroughContextBuilder,
): AgentLoop {
    return new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        session: { snapshot: store.snapshot, store },
    });
}

test("AgentLoop 从 SessionSnapshot 恢复历史并继续对话", async () => {
    const store = new RecordingSessionStore({
        id: "session-1",
        messages: [
            { role: "user", content: "旧问题" },
            { role: "assistant", content: "旧回答" },
        ],
        contextState: { summary: "旧摘要", firstKeptMessageIndex: 1 },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const provider = new FakeProvider([textResponse("新回答")]);
    const agent = createSessionAgent(provider, store);

    await agent.run("新问题");

    assert.deepEqual(provider.requests[0]?.messages, [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "新问题" },
    ]);
    assert.deepEqual(store.appendedMessages, [
        { role: "user", content: "新问题" },
        { role: "assistant", content: "新回答" },
    ]);
    assert.deepEqual(agent.getContextState(), {
        summary: "旧摘要",
        firstKeptMessageIndex: 1,
    });
});

test("AgentLoop 保存 ContextManager 返回的新压缩状态", async () => {
    const store = new RecordingSessionStore(emptySnapshot("session-2"));
    const nextState = { summary: "新摘要", firstKeptMessageIndex: 2 };
    const contextBuilder: ContextBuilder = {
        async build(input) {
            return {
                messages: [...input.messages],
                tools: [...input.tools],
                nextContextState: nextState,
            };
        },
    };
    const agent = createSessionAgent(
        new FakeProvider([textResponse("回答")]),
        store,
        contextBuilder,
    );

    await agent.run("问题");

    assert.deepEqual(store.savedStates, [nextState]);
    assert.deepEqual(agent.getContextState(), nextState);
});
```

- [ ] **Step 2: 运行测试并确认 AgentLoop 尚未接收 Session**

Run:

```bash
npm run test:session --workspace @dkagent/agent
```

Expected: 新测试 FAIL，错误指向 `AgentLoopOptions` 没有 `session` 或恢复历史缺失。

- [ ] **Step 3: 给 AgentLoopOptions 增加可选 Session**

在 `packages/agent/src/agent/types.ts` 导入类型并增加：

```typescript
import type { SessionSnapshot, SessionStore } from "../session/types.js";

export interface AgentLoopSessionOptions {
    /** 当前 AgentLoop 所属的 Session 快照。 */
    snapshot: SessionSnapshot;
    /** 保存当前 Session 增量变化的持久化端口。 */
    store: SessionStore;
}
```

在 `AgentLoopOptions` 中增加：

```typescript
/** 可选 Session；未提供时保持原有纯内存行为。 */
session?: AgentLoopSessionOptions;
```

- [ ] **Step 4: 从快照初始化并集中处理消息写入**

在 `packages/agent/src/agent/loop.ts` 中把字段初始化移入构造函数：

```typescript
private readonly messages: AgentMessage[];
private contextState: ConversationContextState;

public constructor(private readonly options: AgentLoopOptions) {
    this.messages = options.session
        ? [...options.session.snapshot.messages]
        : [];
    this.contextState = options.session
        ? { ...options.session.snapshot.contextState }
        : { summary: "", firstKeptMessageIndex: 0 };
    this.abortSignal = options.abortSignal ?? new AbortController().signal;
    this.tracer = options.tracer ?? new Tracer();
}
```

增加唯一消息入口：

```typescript
private appendMessage(message: AgentMessage): void {
    const session = this.options.session;
    if (session) {
        session.store.appendMessage(session.snapshot.id, message);
    }
    this.messages.push(message);
}
```

把 `run()`、文本响应、Tool Call 响应、Tool Result 中的四处 `this.messages.push(...)` 全部替换为 `this.appendMessage(...)`。

- [ ] **Step 5: 先保存 Context 状态再更新内存**

把 `nextContextState` 分支改为：

```typescript
if (contextSnapshot.nextContextState) {
    const nextState = { ...contextSnapshot.nextContextState };
    const session = this.options.session;
    if (session) {
        session.store.saveContextState(session.snapshot.id, nextState);
    }
    this.contextState = nextState;
}
```

- [ ] **Step 6: 运行 Session 和既有 Phase1 测试**

Run:

```bash
npm run test:session --workspace @dkagent/agent
npm run typecheck:session --workspace @dkagent/agent
npm run test:phase1 --workspace @dkagent/agent
```

Expected:

- Session 测试全部 PASS。
- Session 类型检查退出码为 0。
- Phase1 只允许保留当前既有的 System Prompt 文案断言失败；不得新增 AgentLoop 回归。

- [ ] **Step 7: 提交 AgentLoop 集成**

```bash
git add packages/agent/src/agent/types.ts packages/agent/src/agent/loop.ts packages/agent/test/session/agent-loop-session.test.ts
git commit -m "feat(session): persist agent loop conversation"
```

---

### Task 3: CLI 自动恢复与 `/new`

**Files:**
- Modify: `packages/agent/src/cli/run.ts`

**Interfaces:**
- Consumes: `SqliteSessionStore.loadLatest()`、`create()`，以及 AgentLoop 的 `session` 选项。
- Produces: 默认恢复最近 Session、`/new` 切换到新 Session 的 CLI 行为。

- [ ] **Step 1: 提取基于 SessionSnapshot 创建 AgentLoop 的局部工厂**

在 `packages/agent/src/cli/run.ts` 增加导入：

```typescript
import {
    SqliteSessionStore,
    type SessionSnapshot,
} from "../session/index.js";
```

然后在 `runAgentCli()` 中创建：

```typescript
const sessionStore = new SqliteSessionStore(".dkagent/sessions.db");

const createAgent = (snapshot: SessionSnapshot): AgentLoop =>
    new AgentLoop({
        queryEngine,
        toolRegistry,
        contextManager,
        model: config.model,
        maxContextTokens: config.maxContextTokens,
        maxOutputTokens: config.maxOutputTokens,
        contextCompaction: config.contextCompaction,
        summaryModel: config.summaryModel,
        maxSteps: 5,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        onTextDelta: (text) => process.stdout.write(text),
        tracer,
        session: { snapshot, store: sessionStore },
    });
```

删除原来的单次 `const agent = new AgentLoop(...)`。

- [ ] **Step 2: 启动时恢复最近 Session**

在创建 readline 前增加：

```typescript
const restored = sessionStore.loadLatest();
let currentSession = restored ?? sessionStore.create();
let agent = createAgent(currentSession);

const startupMessage = restored
    ? `DKAgent 已恢复 Session ${currentSession.id}，输入 /new 创建新会话。`
    : `DKAgent 已创建 Session ${currentSession.id}，输入自然语言开始对话。`;
console.log(`${startupMessage}\n`);
```

删除原来的 `DKAgent 已启动` 固定启动文案，避免重复输出。

- [ ] **Step 3: 处理 `/new` 并切换 AgentLoop**

在空输入判断之后、调用 `agent.run()` 之前增加：

```typescript
if (userInput === "/new") {
    currentSession = sessionStore.create();
    agent = createAgent(currentSession);
    console.log(`已创建 Session ${currentSession.id}\n`);
    prompt();
    continue;
}
```

- [ ] **Step 4: CLI 退出时关闭数据库**

把 readline 循环包在 `try/finally` 中，循环体完整保持为：

```typescript
try {
    for await (const input of readline) {
        const userInput = input.trim();
        if (!userInput) {
            prompt();
            continue;
        }
        if (userInput === "/new") {
            currentSession = sessionStore.create();
            agent = createAgent(currentSession);
            console.log(`已创建 Session ${currentSession.id}\n`);
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
} finally {
    sessionStore.close();
}
```

- [ ] **Step 5: 运行无模型请求的 CLI smoke**

Run:

```bash
session_smoke_dir=$(mktemp -d)
cd "$session_smoke_dir"
printf '/new\n' | LLM_API_KEY=test /Users/xuxiaokang/apps/DKAgent/node_modules/.bin/tsx -e 'import { runAgentCli } from "/Users/xuxiaokang/apps/DKAgent/packages/agent/src/cli/run.ts"; await runAgentCli();'
```

Expected: 输出先显示已创建或已恢复 Session，再显示 `/new` 创建了不同 Session；不发送模型请求。

- [ ] **Step 6: 运行全部 Session 范围验证**

Run:

```bash
cd /Users/xuxiaokang/apps/DKAgent
npm run test:session --workspace @dkagent/agent
npm run typecheck:session --workspace @dkagent/agent
git diff --check
```

Expected: Session 测试全部 PASS、Session 类型检查退出码为 0、`git diff --check` 无输出。全包 typecheck 仍可能报告计划执行前已经存在的 Skill/Tool 错误，不将其误报为 Session 回归。

- [ ] **Step 7: 提交 CLI 集成**

```bash
git add packages/agent/src/cli/run.ts
git commit -m "feat(session): resume latest cli conversation"
```

## Final Verification

```bash
npm run test:session --workspace @dkagent/agent
npm run typecheck:session --workspace @dkagent/agent
npm run test:context --workspace @dkagent/agent
npm run typecheck:context --workspace @dkagent/agent
npm run test:phase1 --workspace @dkagent/agent
git diff --check
```

完成判定：Session 与 Context 验证必须通过；Phase1 不得出现新的失败。已知 System Prompt 文案断言与 Session 无关，若仍存在必须单独报告，不能声称全项目测试全部通过。
