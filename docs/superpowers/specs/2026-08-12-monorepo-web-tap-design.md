# DKAgent Monorepo 与 web-tap 迁移设计

## 1. 目标

把当前单包 DKAgent 调整为 npm workspaces Monorepo：Agent 主体位于 `packages/agent`，观测器位于 `packages/web-tap`。

迁移后继续满足：

- Agent Core 不依赖 web-tap。
- web-tap 通过中立 `RuntimeEventSink` 接入 Agent。
- 根目录保留 `npm run agent`、`npm run observe`、`npm test` 等常用命令。
- 不改变 Agent、Context、Tool、Trace 和 Viewer 的运行行为。

## 2. 目标结构

```text
DKAgent/
├── packages/
│   ├── agent/
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web-tap/
│       ├── src/
│       ├── test/
│       ├── package.json
│       └── tsconfig.json
├── docs/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## 3. 包职责

### `@dkagent/agent`

包含：

- `src/agent`、`src/context`、`src/query-engine`、`src/tools`、`src/skills`、`src/knowledge`；
- `src/runtime/events.ts`；
- Agent CLI、配置和原 Agent 测试；
- 现有测试夹具与示例 Markdown。

公开给 web-tap 的最小接口：

- `RuntimeEvent`；
- `RuntimeEventSink`；
- `runAgentCli()`。

### `@dkagent/web-tap`

包含：

- `TapRecorder`；
- `TapServer`；
- Viewer 和 Viewer State；
- `observe` 组合入口；
- Tap 相关测试。

它依赖 `@dkagent/agent`，但 Agent 包不得导入 `@dkagent/web-tap` 或其源码。

## 4. 文件迁移

| 当前路径 | 目标路径 |
| --- | --- |
| `src/agent/**` | `packages/agent/src/agent/**` |
| `src/context/**` | `packages/agent/src/context/**` |
| `src/query-engine/**` | `packages/agent/src/query-engine/**` |
| `src/tools/**` | `packages/agent/src/tools/**` |
| `src/skills/**` | `packages/agent/src/skills/**` |
| `src/knowledge/**` | `packages/agent/src/knowledge/**` |
| `src/runtime/**` | `packages/agent/src/runtime/**` |
| `src/cli/**`、`src/config.ts`、`src/index.ts` | `packages/agent/src/**` |
| `src/tap/**` | `packages/web-tap/src/tap/**` |
| `src/observe.ts` | `packages/web-tap/src/observe.ts` |
| `test/tap/**` | `packages/web-tap/test/**` |
| 其他 `test/**` | `packages/agent/test/**` |
| `tsconfig.*.json` | `packages/agent/tsconfig.*.json` |

web-tap 不复制 Agent 的事件类型；统一从 `@dkagent/agent/runtime-events` 导入。

## 5. Workspace 与命令

根 `package.json` 只承担编排：

```json
{
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "agent": "npm run agent -w @dkagent/agent",
    "observe": "npm run observe -w @dkagent/web-tap",
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`@dkagent/agent` 保留现有 Agent、Knowledge、Context 和 Phase1 脚本。`@dkagent/web-tap` 提供 `observe`、`test` 和 `typecheck`。

## 6. 运行时路径

所有用户输入文件路径和 Trace 路径继续相对 Monorepo 根目录解析，不能因为 npm workspace 默认工作目录变为包目录而改变。

因此：

- 根脚本向子包传入 `DKAGENT_ROOT`，或子包从稳定路径解析 Monorepo 根目录；
- `.traces/events.jsonl` 位于仓库根目录；
- `test/test-short.md` 等命令输入兼容旧路径，CLI 在需要时映射到 `packages/agent/test/...`；
- `.env` 继续从仓库根目录加载。

## 7. 依赖与 TypeScript

- 使用现有 npm 和单一根 `package-lock.json`，不引入 pnpm、Turbo 或新框架。
- 第三方 Agent 依赖移动到 `@dkagent/agent`。
- web-tap 仅依赖 `@dkagent/agent` 和 Node 内置模块。
- 根 `tsconfig.json` 保留共享 compiler options；两个包分别维护 include 和相对路径。
- web-tap 通过 package exports 导入 Agent 公共接口，禁止跨包深层相对路径。

## 8. 迁移顺序

1. 建立 workspace 清单和两个包的配置。
2. 移动 Agent 源码、测试、夹具和 TypeScript 配置，确保根 `npm run agent` 与 Agent 测试可运行。
3. 移动 web-tap 源码与测试，改为依赖 Agent 公共接口。
4. 调整根命令、`.env`、Trace 和用户文件路径。
5. 更新锁文件，执行根级和包级验证。

## 9. 验证

### 结构

- 根目录不再保留业务 `src/` 与 `test/`。
- `packages/agent` 不包含对 `@dkagent/web-tap` 或 `packages/web-tap` 的导入。
- web-tap 不复制 `RuntimeEvent` 类型。

### 自动验证

- `npm run typecheck -w @dkagent/agent`。
- `npm run typecheck -w @dkagent/web-tap`。
- `npm test -w @dkagent/agent`。
- `npm test -w @dkagent/web-tap`。
- `npm test`。

现有 System Prompt 断言失败不属于本次迁移，但迁移不能新增失败。

### 人工验证

- 根目录运行 `npm run agent`，行为与迁移前一致。
- 根目录运行 `npm run observe`，Viewer 仍位于 `http://127.0.0.1:4319/`。
- Trace 写入根目录 `.traces/events.jsonl`。
- Tool 仍能读取用户以旧格式提供的测试文件路径。

## 10. 完成标准

- 代码形成完整 `packages/agent` + `packages/web-tap` Monorepo。
- 根命令保持兼容。
- Agent 与 web-tap 依赖方向单向且可静态检查。
- 没有新增第三方依赖和新的测试失败。
- 原单包路径不再承担运行职责。
