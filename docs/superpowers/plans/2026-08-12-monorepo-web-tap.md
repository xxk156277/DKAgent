# DKAgent Monorepo 与 web-tap 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前单包项目迁移为 `packages/agent` 与 `packages/web-tap` 两个 npm workspace，同时保持根命令和运行行为兼容。

**Architecture:** `@dkagent/agent` 保存 Agent Core、CLI、RuntimeEvent 协议和非 Tap 测试；`@dkagent/web-tap` 单向依赖 Agent 的公开事件与 CLI 接口。根包只负责编排 workspace 命令并持有唯一 lockfile。

**Tech Stack:** npm workspaces、Node.js、TypeScript、tsx、node:test

## Global Constraints

- 目录名必须为 `packages/web-tap`，包名必须为 `@dkagent/web-tap`。
- Agent 包必须为 `packages/agent`，包名必须为 `@dkagent/agent`。
- 依赖方向只能是 `web-tap -> agent`，Agent 禁止导入 web-tap。
- 根目录继续支持 `npm run agent`、`npm run observe`、`npm test` 和 `npm run typecheck`。
- 不引入 pnpm、Turbo、前端框架或新的第三方依赖。
- `.env`、`.traces/events.jsonl` 和用户相对路径继续以 Monorepo 根目录为基准。
- 根目录迁移完成后不保留承担运行职责的 `src/` 和 `test/`。
- 迁移不得新增测试失败；已知 System Prompt 断言失败单独记录。

## File Map

- Create `packages/agent/package.json`: Agent workspace 脚本与 exports。
- Move `src/{agent,cli,context,knowledge,query-engine,runtime,skills,tools}`、`src/config.ts`、`src/index.ts` to `packages/agent/src/`。
- Move 非 Tap 测试与夹具到 `packages/agent/test/`。
- Move `tsconfig.context.json`、`tsconfig.knowledge.json`、`tsconfig.phase1.json` 到 `packages/agent/`。
- Create `packages/web-tap/package.json`: web-tap workspace 和 Agent workspace 依赖。
- Move `src/tap/**`、`src/observe.ts` to `packages/web-tap/src/`。
- Move `test/tap/**` to `packages/web-tap/test/`。
- Modify root `package.json`: 只保留 workspace 编排脚本。
- Modify root `tsconfig.json`: 共享 compiler options。
- Refresh root `package-lock.json`。

---

### Task 1: 建立 npm Workspace 骨架

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/web-tap/package.json`
- Create: `packages/web-tap/tsconfig.json`
- Test: `test/monorepo-layout.test.ts`（Task 4 最终移动到 `packages/agent/test/monorepo-layout.test.ts`）

**Interfaces:**
- Produces: workspace `@dkagent/agent` 与 `@dkagent/web-tap`。
- Produces: Agent exports `./runtime-events` 和 `./cli`。

- [ ] **Step 1: 写 Workspace 结构失败测试**

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("根包声明 agent 与 web-tap workspaces", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(root.workspaces, ["packages/*"]);

  const agent = JSON.parse(await readFile("packages/agent/package.json", "utf8"));
  const tap = JSON.parse(await readFile("packages/web-tap/package.json", "utf8"));
  assert.equal(agent.name, "@dkagent/agent");
  assert.equal(tap.name, "@dkagent/web-tap");
  assert.equal(tap.dependencies["@dkagent/agent"], "*");
  assert.equal(agent.dependencies?.["@dkagent/web-tap"], undefined);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npx tsx --test test/monorepo-layout.test.ts`

Expected: FAIL，根包没有 `workspaces` 或子包配置不存在。

- [ ] **Step 3: 创建根编排配置**

根 `package.json` 调整为：

```json
{
  "name": "dkagent-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "agent": "npm run agent -w @dkagent/agent",
    "observe": "npm run observe -w @dkagent/web-tap",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test:phase1": "npm run test:phase1 -w @dkagent/agent",
    "typecheck:phase1": "npm run typecheck:phase1 -w @dkagent/agent"
  },
  "devDependencies": {
    "@types/node": "^26.1.2",
    "tsx": "^4.23.1",
    "typescript": "^7.0.2"
  }
}
```

根 `tsconfig.json` 保留下面的共享编译选项并删除根级 `include`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  }
}
```

- [ ] **Step 4: 创建两个包配置**

`packages/agent/package.json`：

```json
{
  "name": "@dkagent/agent",
  "private": true,
  "type": "module",
  "exports": {
    "./runtime-events": "./src/runtime/events.ts",
    "./cli": "./src/cli/run.ts"
  },
  "scripts": {
    "agent": "cd ../.. && tsx packages/agent/src/index.ts",
    "test": "cd ../.. && tsx --test packages/agent/test/**/*.test.ts",
    "typecheck": "tsc --noEmit",
    "test:phase1": "cd ../.. && tsx --test packages/agent/test/phase1/*.test.ts",
    "typecheck:phase1": "tsc -p tsconfig.phase1.json --noEmit",
    "test:context": "cd ../.. && tsx --test packages/agent/test/context/*.test.ts",
    "typecheck:context": "tsc -p tsconfig.context.json --noEmit",
    "test:knowledge": "cd ../.. && tsx --test packages/agent/test/knowledge/*.test.ts",
    "typecheck:knowledge": "tsc -p tsconfig.knowledge.json --noEmit",
    "kb:build": "cd ../.. && tsx packages/agent/src/knowledge/cli.ts"
  }
}
```

把当前第三方 `dependencies` 原样放入该文件；开发依赖由根包提供。

`packages/web-tap/package.json`：

```json
{
  "name": "@dkagent/web-tap",
  "private": true,
  "type": "module",
  "scripts": {
    "observe": "cd ../.. && tsx packages/web-tap/src/observe.ts",
    "test": "cd ../.. && tsx --test packages/web-tap/test/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dkagent/agent": "*"
  }
}
```

两个包的 `tsconfig.json` 均 `extends: "../../tsconfig.json"`，设置 `rootDir: "../.."`，并分别 include 自身 `src/**/*.ts` 与 `test/**/*.ts`。

- [ ] **Step 5: 验证 Workspace 配置测试转绿**

Run: `npx tsx --test test/monorepo-layout.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交 Workspace 骨架**

```bash
git add package.json tsconfig.json packages/agent/package.json packages/agent/tsconfig.json packages/web-tap/package.json packages/web-tap/tsconfig.json test/monorepo-layout.test.ts
git commit -m "build: establish DKAgent workspaces"
```

---

### Task 2: 迁移 Agent 包

**Files:**
- Move: Agent 源码、非 Tap 测试、测试夹具、三个专用 tsconfig 到 `packages/agent/`
- Modify: `packages/agent/tsconfig*.json`
- Modify: `packages/agent/src/tools/tool-item/split.ts`（仅当路径兼容测试要求）

**Interfaces:**
- Produces: `@dkagent/agent/runtime-events`。
- Produces: `@dkagent/agent/cli` 的 `runAgentCli()`。
- Preserves: 根目录运行命令时 `process.cwd()` 为 Monorepo 根目录。

- [ ] **Step 1: 批量移动 Agent 文件**

```bash
mkdir -p packages/agent/src packages/agent/test
git mv src/agent src/cli src/context src/knowledge src/query-engine src/runtime src/skills src/tools packages/agent/src/
git mv src/config.ts src/index.ts packages/agent/src/
git mv test/context test/fixtures test/knowledge test/phase1 test/query-engine test/runtime packages/agent/test/
git mv test/test-short.md test/test-longer.md packages/agent/test/
git mv tsconfig.context.json tsconfig.knowledge.json tsconfig.phase1.json packages/agent/
```

- [ ] **Step 2: 移动 Workspace 结构测试并更新路径**

```bash
git mv test/monorepo-layout.test.ts packages/agent/test/monorepo-layout.test.ts
```

测试中的根文件读取使用：

```ts
const root = new URL("../../../", import.meta.url);
const readJson = async (path: string) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
```

- [ ] **Step 3: 修正 Agent TypeScript 配置**

所有专用配置的 `extends` 改为 `./tsconfig.json`，include 路径保持包内 `src/**`、`test/**`。`packages/agent/tsconfig.json` 包含：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "rootDir": "../.." },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: 更新测试内的用户文件路径**

把测试代码中的 `test/test-short.md`、`test/test-longer.md` 更新为 `packages/agent/test/test-short.md`、`packages/agent/test/test-longer.md`。生产 Tool 仍直接接收用户提供的仓库根相对路径，不加入隐藏 fallback。

- [ ] **Step 5: 验证 Agent 包**

Run: `npm install`

Expected: 根 `package-lock.json` 更新，`node_modules/@dkagent/agent` 指向 workspace。

Run: `npm run typecheck:phase1 -w @dkagent/agent`

Expected: PASS。

Run: `npm test -w @dkagent/agent`

Expected: 与迁移前基线一致；只允许已知 System Prompt 断言失败。

- [ ] **Step 6: 静态验证 Agent 不依赖 web-tap**

Run: `rg -n 'web-tap|packages/web-tap|src/tap' packages/agent/src packages/agent/test`

Expected: 无输出。

- [ ] **Step 7: 提交 Agent 迁移**

```bash
git add packages/agent package-lock.json
git commit -m "refactor: move Agent into workspace"
```

---

### Task 3: 迁移 web-tap 包

**Files:**
- Move: `src/tap/**` to `packages/web-tap/src/tap/**`
- Move: `src/observe.ts` to `packages/web-tap/src/observe.ts`
- Move: `test/tap/**` to `packages/web-tap/test/**`
- Modify: moved web-tap imports

**Interfaces:**
- Consumes: `@dkagent/agent/runtime-events`。
- Consumes: `@dkagent/agent/cli`。
- Produces: `npm run observe -w @dkagent/web-tap`。

- [ ] **Step 1: 先让跨包导入测试失败**

移动测试后，将所有 RuntimeEvent 类型导入改成：

```ts
import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
```

Run: `npm test -w @dkagent/web-tap`

Expected: FAIL，web-tap 生产源码仍引用已不存在的根相对路径。

- [ ] **Step 2: 移动 web-tap 文件**

```bash
mkdir -p packages/web-tap/src packages/web-tap/test
git mv src/tap packages/web-tap/src/
git mv src/observe.ts packages/web-tap/src/
git mv test/tap/* packages/web-tap/test/
rmdir test/tap test src
```

- [ ] **Step 3: 改为 Package Exports 导入**

`recorder.ts`、`viewer-state.ts` 和测试中的事件类型统一使用：

```ts
import type {
  RuntimeEvent,
  RuntimeEventSink,
} from "@dkagent/agent/runtime-events";
```

`packages/web-tap/src/observe.ts` 使用：

```ts
import "dotenv/config";
import { join } from "node:path";
import { runAgentCli } from "@dkagent/agent/cli";
import { TapRecorder } from "./tap/recorder.js";
import { startTapServer } from "./tap/server.js";
```

因为 workspace 脚本先 `cd ../..`，`.env`、`.traces` 和用户相对路径均以根目录解析。

- [ ] **Step 4: 更新 observe 子进程测试**

将子进程入口改为：

```ts
spawn(process.execPath, ["--import", "tsx", "packages/web-tap/src/observe.ts"], {
  cwd: monorepoRoot,
  env: { ...process.env, LLM_API_KEY: "dummy", LLM_MODEL_ID: "dummy" },
});
```

- [ ] **Step 5: 验证 web-tap 包**

Run: `npm run typecheck -w @dkagent/web-tap`

Expected: PASS。

Run: `npm test -w @dkagent/web-tap`

Expected: Tap 测试全部 PASS。

Run: `rg -n '\.\./\.\./.*agent|src/runtime|src/cli' packages/web-tap`

Expected: 无跨包深层相对导入。

- [ ] **Step 6: 提交 web-tap 迁移**

```bash
git add packages/web-tap
git commit -m "refactor: move observer into web-tap workspace"
```

---

### Task 4: 根命令兼容与完整验收

**Files:**
- Modify: `package-lock.json`
- Modify: `.gitignore`（仅在现有规则不覆盖根 `.traces/` 时）
- Test: `packages/agent/test/monorepo-layout.test.ts`

**Interfaces:**
- Preserves: 根 `npm run agent`、`npm run observe`、`npm test`、`npm run typecheck`。

- [ ] **Step 1: 增加迁移完成结构断言**

在 `monorepo-layout.test.ts` 增加：

```ts
import { access } from "node:fs/promises";

await assert.rejects(access(new URL("src", root)));
await assert.rejects(access(new URL("test", root)));
await access(new URL("packages/agent/src/index.ts", root));
await access(new URL("packages/web-tap/src/observe.ts", root));
```

- [ ] **Step 2: 更新锁文件并验证 Workspace 链接**

Run: `npm install`

Expected: `npm ls @dkagent/agent @dkagent/web-tap` 显示两个 workspace，web-tap 依赖 Agent workspace。

- [ ] **Step 3: 运行包级验证**

Run: `npm run typecheck:phase1 -w @dkagent/agent`

Expected: PASS。

Run: `npm test -w @dkagent/web-tap`

Expected: 全部 PASS。

Run: `npm test -w @dkagent/agent`

Expected: 不新增失败；保留已知 System Prompt 基线失败。

- [ ] **Step 4: 运行根级验证**

Run: `npm run typecheck`

Expected: 若仍有迁移前已知的旧 Tool/Skill 类型错误，输出文件必须全部位于 `packages/agent`，且不得新增 workspace、web-tap 或模块解析错误。

Run: `npm test`

Expected: 结果等于两个包测试汇总；不新增失败。

- [ ] **Step 5: 验证依赖方向和旧目录清理**

Run: `test ! -d src && test ! -d test`

Expected: PASS。

Run: `rg -n '@dkagent/web-tap|packages/web-tap' packages/agent`

Expected: 无输出。

Run: `rg -n '\.\./\.\./.*agent|src/runtime|src/cli' packages/web-tap`

Expected: 无跨包深层相对导入。

- [ ] **Step 6: Dummy 启动验证**

Run: `LLM_API_KEY=dummy LLM_MODEL_ID=dummy npm run observe`

Expected: 输出 `DKAgent Tap：http://127.0.0.1:4319/` 和 `DKAgent 已启动`；不输入对话，不请求模型。

另一个终端执行：

```bash
curl --fail --silent http://127.0.0.1:4319/api/events
```

Expected: 返回 JSON 数组，Trace 位于根 `.traces/events.jsonl`。

- [ ] **Step 7: 最终提交**

```bash
git add package.json package-lock.json tsconfig.json packages .gitignore
git commit -m "build: complete DKAgent monorepo migration"
```

- [ ] **Step 8: 状态检查**

Run: `git status --short`

Expected: 无未提交变更。
