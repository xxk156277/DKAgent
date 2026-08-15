# Session 小幅完善实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DKAgent 补齐 Session 列出、按 ID 加载、切换和删除能力，并禁止删除当前 Session。

**Architecture:** CLI 和 SQLite Store 保持存活，`/switch` 先加载目标 `SessionSnapshot`，成功后创建新的 `AgentLoop` 并替换当前引用。Session 的查询和删除统一进入 `SessionStore`，CLI 不直接执行 SQL；删除当前 Session 的运行时规则由 CLI 判断。

**Tech Stack:** TypeScript、Node.js、better-sqlite3、node:test、tsx

## Global Constraints

- 所有新增类型属性必须有具体中文注释。
- `/switch` 必须先成功加载目标 Session，再替换当前 `AgentLoop`。
- `/delete` 禁止删除当前 Session，提示用户先执行 `/new` 或 `/switch`。
- `list()` 按 `updatedAt` 倒序返回；相同时间使用 SQLite `rowid` 倒序保证结果稳定。
- 删除 Session 与关联消息必须处于同一个 SQLite 事务。
- 不新增 Session 名称、统计、状态机、Checkpoint、分支、事件回放或 Memory。
- 不修改或提交运行时数据库 `.dkagent/sessions.db`。

---

## 文件结构

- `packages/agent/src/session/types.ts`：定义 `SessionSummary`，扩展 `SessionStore` 端口。
- `packages/agent/src/session/store.ts`：实现 Session 列表、按 ID 加载和事务删除。
- `packages/agent/src/session/index.ts`：导出新增的 `SessionSummary` 类型。
- `packages/agent/src/cli/run.ts`：解析 `/sessions`、`/switch`、`/delete`，替换 `AgentLoop`。
- `packages/agent/test/session/store.test.ts`：验证 Store 的新增行为。
- `packages/agent/test/session/agent-loop-session.test.ts`：补齐测试替身对扩展接口的实现。
- `packages/agent/test/session/cli-session.test.mjs`：通过真实 CLI 子进程验证命令生命周期。

### Task 1: 扩展 SessionStore 查询与删除能力

**Files:**
- Modify: `packages/agent/src/session/types.ts`
- Modify: `packages/agent/src/session/store.ts`
- Modify: `packages/agent/src/session/index.ts`
- Modify: `packages/agent/test/session/store.test.ts`
- Modify: `packages/agent/test/session/agent-loop-session.test.ts`

**Interfaces:**
- Consumes: 现有 `SessionSnapshot`、SQLite `sessions` 与 `session_messages` 表。
- Produces: `SessionSummary`、`SessionStore.list(): SessionSummary[]`、`SessionStore.load(sessionId: string): SessionSnapshot | null`、`SessionStore.delete(sessionId: string): boolean`。

- [ ] **Step 1: 在 Store 测试中写出列表、按 ID 加载和删除的失败用例**

在 `packages/agent/test/session/store.test.ts` 末尾添加：

```ts
test("可以列出 Session 并按 ID 加载完整快照", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const store = new SqliteSessionStore(join(directory, "sessions.db"));
    const firstSession = store.create();
    store.appendMessage(firstSession.id, {
        role: "user",
        content: "第一条 Session 的问题",
    });
    const secondSession = store.create();

    const sessions = store.list();
    const loaded = store.load(firstSession.id);

    assert.deepEqual(
        sessions.map((session) => session.id),
        [secondSession.id, firstSession.id],
    );
    assert.deepEqual(loaded?.messages, [
        { role: "user", content: "第一条 Session 的问题" },
    ]);
    assert.equal(loaded?.id, firstSession.id);
    assert.equal(store.load("missing-session"), null);
    store.close();
});

test("删除 Session 时同时删除关联消息", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-session-"));
    const store = new SqliteSessionStore(join(directory, "sessions.db"));
    const session = store.create();
    store.appendMessage(session.id, {
        role: "user",
        content: "删除后不应保留的消息",
    });

    assert.equal(store.delete(session.id), true);
    assert.equal(store.load(session.id), null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.delete(session.id), false);
    store.close();
});
```

- [ ] **Step 2: 运行 Store 测试并确认接口尚不存在**

Run:

```bash
cd /Users/xuxiaokang/apps/DKAgent
npx tsx --test packages/agent/test/session/store.test.ts
```

Expected: FAIL，错误包含 `store.list is not a function` 或 TypeScript 报告 `list`、`load`、`delete` 不存在。

- [ ] **Step 3: 定义 SessionSummary 并扩展 SessionStore 接口**

在 `packages/agent/src/session/types.ts` 的 `SessionSnapshot` 后添加：

```ts
/** Session 列表展示所需的轻量元数据，不包含消息正文。 */
export interface SessionSummary {
    /** Session 唯一标识。 */
    id: string;
    /** Session 创建时间。 */
    createdAt: string;
    /** Session 最近一次持久化更新时间。 */
    updatedAt: string;
}
```

在 `SessionStore` 中，将 `loadLatest()` 前的接口补充为：

```ts
    /** 按最近更新时间从新到旧列出所有 Session。 */
    list(): SessionSummary[];
    /** 按唯一标识加载完整 Session；不存在时返回 null。 */
    load(sessionId: string): SessionSnapshot | null;
    /** 加载最近更新的 Session；不存在时返回 null。 */
    loadLatest(): SessionSnapshot | null;
    /** 删除 Session 及其关联消息；不存在时返回 false。 */
    delete(sessionId: string): boolean;
```

- [ ] **Step 4: 实现列表、按 ID 加载和事务删除**

在 `packages/agent/src/session/store.ts` 的类型导入中加入 `SessionSummary`：

```ts
import type {
    SessionSnapshot,
    SessionStore,
    SessionSummary,
} from "./types.js";
```

在 `MessageRow` 后添加列表查询行类型：

```ts
/** Session 列表元数据查询结果。 */
interface SessionSummaryRow {
    /** Session 唯一标识。 */
    id: string;
    /** Session 创建时间。 */
    created_at: string;
    /** Session 最近更新时间。 */
    updated_at: string;
}
```

在 `create()` 后添加：

```ts
    /** 按更新时间从新到旧列出 Session，不读取消息正文。 */
    public list(): SessionSummary[] {
        const rows = this.database.prepare(`
            SELECT id, created_at, updated_at
            FROM sessions
            ORDER BY updated_at DESC, rowid DESC
        `).all() as SessionSummaryRow[];

        return rows.map((row) => ({
            id: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    /** 按唯一标识加载 Session 及其完整消息。 */
    public load(sessionId: string): SessionSnapshot | null {
        const row = this.database.prepare(`
            SELECT
                id,
                summary,
                first_kept_message_index,
                created_at,
                updated_at
            FROM sessions
            WHERE id = ?
        `).get(sessionId) as SessionRow | undefined;

        return row ? this.buildSnapshot(row) : null;
    }
```

将现有 `loadLatest()` 中从查询消息到返回快照的逻辑替换为：

```ts
        if (!row) return null;
        return this.buildSnapshot(row);
```

在 `saveContextState()` 前添加：

```ts
    /** 以事务方式删除 Session 及其关联消息。 */
    public delete(sessionId: string): boolean {
        const remove = this.database.transaction(() => {
            this.database.prepare(`
                DELETE FROM session_messages
                WHERE session_id = ?
            `).run(sessionId);

            const result = this.database.prepare(`
                DELETE FROM sessions
                WHERE id = ?
            `).run(sessionId);

            return result.changes === 1;
        });

        return remove();
    }
```

在 `touch()` 前添加快照组装方法，并把原 `loadLatest()` 中的消息 JSON 解析逻辑移动到这里：

```ts
    /** 将 Session 行和关联消息组装为可恢复快照。 */
    private buildSnapshot(row: SessionRow): SessionSnapshot {
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
            const message = error instanceof Error
                ? error.message
                : String(error);
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
```

- [ ] **Step 5: 导出 SessionSummary 并补齐测试 Store 替身**

将 `packages/agent/src/session/index.ts` 的类型导出改为：

```ts
export type {
    SessionSnapshot,
    SessionStore,
    SessionSummary,
} from "./types.js";
```

在 `packages/agent/test/session/agent-loop-session.test.ts` 的类型导入中加入 `SessionSummary`，在 `RecordingSessionStore` 中添加 Session ID 记录和新增接口：

```ts
    public readonly appendedSessionIds: string[] = [];

    public list(): SessionSummary[] {
        return [{
            id: this.snapshot.id,
            createdAt: this.snapshot.createdAt,
            updatedAt: this.snapshot.updatedAt,
        }];
    }

    public load(sessionId: string): SessionSnapshot | null {
        return sessionId === this.snapshot.id ? this.snapshot : null;
    }

    public delete(sessionId: string): boolean {
        return sessionId === this.snapshot.id;
    }
```

将 `appendMessage()` 的 `_sessionId` 参数改为 `sessionId`，并记录写入目标：

```ts
    public appendMessage(sessionId: string, message: AgentMessage): void {
        this.appendedSessionIds.push(sessionId);
        this.appendedMessages.push(structuredClone(message));
    }
```

在“AgentLoop 从 SessionSnapshot 恢复历史并继续对话”测试中，`appendedMessages` 断言后添加：

```ts
    assert.deepEqual(store.appendedSessionIds, ["session-1", "session-1"]);
```

该断言验证切换后创建的新 `AgentLoop` 会把用户消息和回答写入目标快照的 Session ID，而不是原 Session。

- [ ] **Step 6: 运行 Session Store 测试和类型检查**

Run:

```bash
cd /Users/xuxiaokang/apps/DKAgent
npx tsx --test packages/agent/test/session/store.test.ts packages/agent/test/session/agent-loop-session.test.ts
npm run typecheck:session -w @dkagent/agent
```

Expected: 两组测试全部 PASS，TypeScript 命令退出码为 `0`。

- [ ] **Step 7: 提交 Store 能力**

```bash
cd /Users/xuxiaokang/apps/DKAgent
git add packages/agent/src/session/types.ts \
        packages/agent/src/session/store.ts \
        packages/agent/src/session/index.ts \
        packages/agent/test/session/store.test.ts \
        packages/agent/test/session/agent-loop-session.test.ts
git commit -m "feat: 补齐 Session 查询和删除能力"
```

### Task 2: 增加 Session CLI 管理命令

**Files:**
- Modify: `packages/agent/src/cli/run.ts`
- Modify: `packages/agent/test/session/cli-session.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `SessionStore.list()`、`load()`、`delete()` 和现有 `createAgent(snapshot)`。
- Produces: `/sessions`、`/switch <sessionId>`、`/delete <sessionId>` 命令行为。

- [ ] **Step 1: 添加可交互 CLI 子进程测试工具**

将 `packages/agent/test/session/cli-session.test.mjs` 中的子进程导入改为：

```js
import { spawn, spawnSync } from "node:child_process";
```

在 `cliModuleUrl` 后添加：

```js
function startCli(workingDirectory) {
    const script = `
        import { runAgentCli } from ${JSON.stringify(cliModuleUrl)};
        runAgentCli().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const child = spawn(tsxPath, ["-e", script], {
        cwd: workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    const waitForOutput = (pattern, fromIndex = 0) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`等待 CLI 输出超时：${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 10_000);
        const check = () => {
            const match = stdout.slice(fromIndex).match(pattern);
            if (!match) return;
            cleanup();
            resolve(match);
        };
        const onExit = (code) => {
            cleanup();
            reject(new Error(`CLI 提前退出：${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        };
        const cleanup = () => {
            clearTimeout(timeout);
            child.stdout.off("data", check);
            child.off("exit", onExit);
        };
        child.stdout.on("data", check);
        child.on("exit", onExit);
        check();
    });

    const waitForExit = () => new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
    });

    return {
        child,
        output: () => stdout,
        errorOutput: () => stderr,
        waitForOutput,
        waitForExit,
    };
}
```

- [ ] **Step 2: 写出 Session 列表、切换和删除的失败用例**

在 `packages/agent/test/session/cli-session.test.mjs` 末尾添加：

```js
test("CLI 可以列出、切换和删除非当前 Session", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-session-"));
    const cli = startCli(workingDirectory);

    const startup = await cli.waitForOutput(
        /DKAgent 已创建 Session ([0-9a-f-]{36})/,
    );
    const firstSessionId = startup[1];

    let outputIndex = cli.output().length;
    cli.child.stdin.write("/new\n");
    const created = await cli.waitForOutput(
        /已创建 Session ([0-9a-f-]{36})/,
        outputIndex,
    );
    const secondSessionId = created[1];

    outputIndex = cli.output().length;
    cli.child.stdin.write("/sessions\n");
    await cli.waitForOutput(
        new RegExp(`\\* ${secondSessionId}[\\s\\S]*  ${firstSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${firstSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已切换到 Session ${firstSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/delete ${firstSessionId}\n`);
    await cli.waitForOutput(/不能删除当前 Session/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${secondSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已切换到 Session ${secondSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/delete ${firstSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已删除 Session ${firstSessionId}`),
        outputIndex,
    );

    const exitPromise = cli.waitForExit();
    cli.child.stdin.end();
    const exitCode = await exitPromise;
    assert.equal(exitCode, 0, cli.errorOutput());
});
```

- [ ] **Step 3: 运行 CLI 测试并确认新命令尚未实现**

Run:

```bash
cd /Users/xuxiaokang/apps/DKAgent
node --test packages/agent/test/session/cli-session.test.mjs
```

Expected: 新测试 FAIL，并因 `/sessions` 被当作普通用户消息而等待输出超时。

- [ ] **Step 4: 在 CLI 输入循环中实现三个命令**

在 `packages/agent/src/cli/run.ts` 的 `/new` 分支后、调用 `agent.run()` 前添加：

```ts
            if (userInput === "/sessions") {
                const sessions = sessionStore.list();
                const lines = sessions.map((session) => {
                    const marker = session.id === currentSession.id ? "*" : " ";
                    return `${marker} ${session.id}  ${session.updatedAt}`;
                });
                console.log(`${lines.join("\n")}\n`);
                prompt();
                continue;
            }

            if (userInput === "/switch" || userInput.startsWith("/switch ")) {
                const sessionId = userInput.slice("/switch".length).trim();
                if (!sessionId) {
                    console.log("用法：/switch <sessionId>\n");
                    prompt();
                    continue;
                }
                if (sessionId === currentSession.id) {
                    console.log(`已经是当前 Session ${sessionId}\n`);
                    prompt();
                    continue;
                }

                const snapshot = sessionStore.load(sessionId);
                if (!snapshot) {
                    console.log(`Session ${sessionId} 不存在\n`);
                    prompt();
                    continue;
                }

                const nextAgent = createAgent(snapshot);
                currentSession = snapshot;
                agent = nextAgent;
                console.log(`已切换到 Session ${sessionId}\n`);
                prompt();
                continue;
            }

            if (userInput === "/delete" || userInput.startsWith("/delete ")) {
                const sessionId = userInput.slice("/delete".length).trim();
                if (!sessionId) {
                    console.log("用法：/delete <sessionId>\n");
                    prompt();
                    continue;
                }
                if (sessionId === currentSession.id) {
                    console.log("不能删除当前 Session，请先执行 /new 或 /switch。\n");
                    prompt();
                    continue;
                }
                if (!sessionStore.delete(sessionId)) {
                    console.log(`Session ${sessionId} 不存在\n`);
                    prompt();
                    continue;
                }

                console.log(`已删除 Session ${sessionId}\n`);
                prompt();
                continue;
            }
```

这里必须保持顺序：`sessionStore.load()` 成功后先构造 `nextAgent`，最后才更新 `currentSession` 和 `agent` 引用。

- [ ] **Step 5: 增加缺少 ID、重复切换和不存在 Session 的 CLI 断言**

在同一个 CLI 测试中，第一次 `/new` 后、`/sessions` 前依次写入以下命令并断言：

```js
    outputIndex = cli.output().length;
    cli.child.stdin.write("/switch\n");
    await cli.waitForOutput(/用法：\/switch <sessionId>/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${secondSessionId}\n`);
    await cli.waitForOutput(/已经是当前 Session/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/switch missing-session\n");
    await cli.waitForOutput(/Session missing-session 不存在/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/delete\n");
    await cli.waitForOutput(/用法：\/delete <sessionId>/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/delete missing-session\n");
    await cli.waitForOutput(/Session missing-session 不存在/, outputIndex);
```

- [ ] **Step 6: 运行完整 Session 验证**

Run:

```bash
cd /Users/xuxiaokang/apps/DKAgent
npm run test:session -w @dkagent/agent
npm run typecheck:session -w @dkagent/agent
```

Expected:

```text
Session 测试全部 PASS
typecheck:session 退出码 0
```

- [ ] **Step 7: 提交 CLI 管理能力**

```bash
cd /Users/xuxiaokang/apps/DKAgent
git add packages/agent/src/cli/run.ts \
        packages/agent/test/session/cli-session.test.mjs
git commit -m "feat: 增加 Session 管理命令"
```

### Task 3: 最终范围检查

**Files:**
- Verify: `packages/agent/src/session/types.ts`
- Verify: `packages/agent/src/session/store.ts`
- Verify: `packages/agent/src/cli/run.ts`
- Verify: `packages/agent/test/session/`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的完整实现。
- Produces: 可交付的 Session 小幅完善功能及范围证据。

- [ ] **Step 1: 重跑 Session 测试和类型检查**

```bash
cd /Users/xuxiaokang/apps/DKAgent
npm run test:session -w @dkagent/agent
npm run typecheck:session -w @dkagent/agent
```

Expected: 两条命令退出码均为 `0`。

- [ ] **Step 2: 检查改动范围**

```bash
cd /Users/xuxiaokang/apps/DKAgent
git status --short
git diff HEAD~2..HEAD -- packages/agent/src/session packages/agent/src/cli/run.ts packages/agent/test/session
```

Expected: 功能提交只修改计划列出的 Session、CLI 和测试文件；`.dkagent/sessions.db` 仍是用户既有的未提交运行时文件，没有进入任何提交。
