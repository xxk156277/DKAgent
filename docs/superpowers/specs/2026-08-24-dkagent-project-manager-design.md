# DKAgent 项目管家 Skill 设计

**日期：** 2026-08-24
**状态：** 已确认设计，尚未实现

## 1. 结论

为 DKAgent 增加一个仓库级 Codex 项目管家 Skill。它不进入 DKAgent 运行时，也不编写业务代码；它负责在多个 Agent、多个 Git Worktree 并行开发时，基于可验证证据维护项目规则、当前进度和待办优先级。

采用“Worker 多写事件，Project Manager 单写文档”的结构：每个开发 Agent 只向 Git 共享目录追加自己的任务事件，项目管家通过全局锁汇总事件，并且只在指定管理 Worktree 中更新 `AGENTS.md`、`docs/project/STATUS.md` 和 `docs/project/BACKLOG.md`。

## 2. 当前事实与假设

- DKAgent 是 TypeScript/Node.js Monorepo，开发可能分散在多个 Worktree 和分支中。
- 项目设计、当前实现和进行中的计划必须区分；文件存在或任务已规划不代表功能已经完成。
- 根仓库当前没有受版本控制的 `AGENTS.md`，项目状态也没有统一入口。
- 当前 `.gitignore` 忽略整个 `docs/`，但仓库已经显式跟踪部分设计文档；实现时只精确加入本设计要求的新文档，不顺手调整整个忽略规则。
- 管理 Worktree 默认是主仓库检出目录，并要求位于配置的管理分支 `main`。具体绝对路径属于本机状态，不写入仓库。
- 多个模块可以并行开发；WIP=1 表示每个 Agent/Worktree 同时只执行一个任务，不是整个项目只能有一个进行中任务。

## 3. 目标

1. 让任何 Agent 能快速获得项目目标、当前进度、阻塞和下一优先事项。
2. 每个开发任务开始和结束时自动同步状态，不依赖 Agent 凭记忆修改文档。
3. 支持多个 Worktree 并行上报，避免多个 Agent 同时覆盖状态文档。
4. 只有存在验证证据时才把任务标记为完成。
5. 自动排序待办，同时保留排序理由、来源和依赖。
6. 删除、延期或改变项目目标前必须获得用户确认。

## 4. 非目标

- 不接入 DKAgent AgentLoop、ToolRegistry 或业务运行时。
- 不自动编写业务代码、创建 PR、合并分支、发布或删除 Worktree。
- 不建设 Web 看板、数据库、外部任务服务或后台常驻进程。
- 不自动修改 `desginDocs/`、OpenSpec 或其他业务设计文档。
- 不根据代码量猜测进度，不编造工期、截止日期或完成比例。
- 不自动提交项目管理文档；提交仍属于正常开发交付流程。

## 5. 方案比较

### 方案 A：共享事件加单写者汇总（采用）

每个 Worker 追加独立事件，项目管家持锁更新统一文档。并发安全、职责明确，可以保留跨 Worktree 的真实证据。

### 方案 B：每个 Worktree 直接修改管理文档（拒绝）

实现简单，但 `STATUS.md` 和 `BACKLOG.md` 会频繁产生合并冲突，后完成的 Agent 也可能覆盖其他 Worktree 的状态。

### 方案 C：外部数据库或任务服务（暂缓）

实时性和查询能力更强，但需要服务、鉴权、持久化和同步协议，不符合 V1 的最小范围。

## 6. 架构

```text
Worktree A / Agent A ─┐
Worktree B / Agent B ─┼─> Git common-dir 事件收件箱
Worktree C / Agent C ─┘          │
                                 │ 加锁、去重、验证
                                 v
                     Project Manager 单写者
                                 │
                                 v
          管理 Worktree 中的 AGENTS / STATUS / BACKLOG
```

### 6.1 Worker 模式

所有开发 Agent 通过同一个 Skill 执行两个入口：

- `worker-start`：认领一个已有待办 ID；若是计划外工作则生成唯一 ID。记录模块、Worktree、分支、HEAD 和依赖，然后进入 `in_progress`。
- `worker-finish`：记录任务结果、验证证据、阻塞原因、新发现待办和依赖变化。完成后立即尝试触发汇总。

Worker 不直接修改三份项目管理文档。

### 6.2 Project Manager 模式

`aggregate` 获取全局写锁，读取所有未处理事件，执行以下步骤：

1. 按事件 ID 幂等去重，并按任务 ID 合并同一任务的状态变化。
2. 检查同一任务是否被多个 Worktree 同时认领。
3. 验证“完成”状态是否包含可复查证据。
4. 合并新待办、依赖、阻塞和优先级变化。
5. 检查管理 Worktree、管理分支及目标文档是否处于可安全更新状态。
6. 外科手术式更新三份文档，并记录处理结果。

## 7. 共享本机状态

Skill 使用 `git rev-parse --git-common-dir` 找到所有 Worktree 共享的 Git 目录，并在其下维护不进入版本控制的状态：

```text
<git-common-dir>/dkagent-project-manager/
├── config.json
├── aggregate.lock/
├── events/
│   ├── pending/<event-id>.json
│   └── processed/<event-id>.json
└── state.json
```

- `config.json`：保存管理 Worktree 绝对路径和允许写入的管理分支，默认分支为 `main`。
- `pending/`：Worker 以唯一文件名原子追加事件，无需共享写文件。
- `processed/`：已汇总事件，便于审计和故障恢复。
- `state.json`：已处理事件 ID、上次写入文档的内容哈希和汇总时间。
- `aggregate.lock/`：使用原子目录创建实现互斥；锁竞争时不阻塞开发任务，事件保留到下一次汇总。

这些文件是 Skill 的运行状态，不是第四套项目文档。删除某个 Worktree 不会删除 Git common-dir 中的待汇总事件。

## 8. 事件契约

每条事件只保存状态摘要，不保存长日志、环境变量或密钥。

```ts
type ProjectEvent = {
  schemaVersion: 1;
  eventId: string;
  taskId: string;
  action: "started" | "finished" | "blocked" | "discovered";
  module: string;
  summary: string;
  worktreePath: string;
  branch: string;
  headSha: string;
  status: "in_progress" | "completed" | "needs_verification" | "blocked";
  dependencies: string[];
  evidence: Array<{
    kind: "test" | "typecheck" | "build" | "commit" | "user_confirmation";
    summary: string;
    command?: string;
    exitCode?: number;
  }>;
  discoveredTodos: Array<{
    summary: string;
    module: string;
    reason: string;
  }>;
  createdAt: string;
};
```

同一任务正常情况下必须复用同一个 `taskId`。项目管家只能提示语义疑似重复的不同 ID，不能自动合并它们。

## 9. 三份项目文档

### 9.1 `AGENTS.md`

只保存稳定、低频变化的规则：

- 项目目标和文档事实来源优先级。
- 编码、验证和事实表述规则。
- 多 Worktree 任务认领与 WIP=1 规则。
- 开发任务开始、结束时必须调用项目管家 Skill。
- 禁止把设计、计划、文件存在或未验证实现写成完成状态。

普通任务完成时不重复改写 `AGENTS.md`。只有稳定规则发生变化并得到用户确认后才更新。

### 9.2 `docs/project/STATUS.md`

保存当前事实快照：

- 当前里程碑。
- 各 Worktree 的活跃任务、分支和 HEAD。
- 最近完成任务及验证证据。
- 待验证、阻塞和风险。
- 最后汇总时间。

不得使用没有可验证分母的百分比进度。

### 9.3 `docs/project/BACKLOG.md`

使用固定字段：

```text
ID | P0-P3 | 模块 | 状态 | 依赖 | 排序理由 | 来源 | 最近更新
```

状态至少包含 `ready`、`in_progress`、`needs_verification`、`blocked` 和 `completed`。完成项可以保留近期窗口，较老记录由后续明确的归档设计处理，V1 不自动删除。

## 10. 优先级规则

优先级按以下顺序判断，不引入复杂评分公式：

1. 用户明确指定的顺序最高。
2. P0：阻塞多个任务、明确的安全/数据风险或发布阻塞。
3. P1：当前里程碑关键路径或能解除重要依赖。
4. P2：下一阶段可独立交付的价值。
5. P3：候选优化、学习项或尚未进入近期范围的工作。

同一优先级内先解除依赖，再考虑风险和交付价值。项目管家可以自动调整顺序并记录理由，但不能自行删除、延期或改变项目目标。

## 11. 状态与证据规则

- `completed`：实现已经结束，并有与任务验收目标相关的测试、类型检查、构建或明确用户验收证据；证据必须能指向具体命令和结果。提交 SHA 只作为版本来源，不能单独证明代码任务完成。纯文档或规则任务可以用明确用户验收替代代码测试。
- `needs_verification`：代码可能已实现，但验证未运行、失败或不足以证明目标。
- `blocked`：存在明确外部依赖、冲突、权限、环境或需求阻塞，并记录解除条件。
- `in_progress`：某个 Worktree 已认领并正在执行。

配置测试、类型检查或局部 Fake Provider 测试不能被描述成真实 Provider/API 的端到端验证。项目管家只记录当前证据实际证明的范围。

## 12. 并发与故障处理

- **同任务重复认领：** 生成 P0 冲突，停止自动决策，由用户选择保留哪个执行者。
- **事件重复：** 根据 `eventId` 幂等忽略，不重复修改文档。
- **写锁占用：** 保留 pending 事件并报告“待汇总”，下一次 `worker-start`、`worker-finish` 或显式同步时重试。
- **管理 Worktree 不存在或分支不匹配：** 不跨分支写入，保留事件并报告配置问题。
- **文档被外部修改：** 若内容哈希与项目管家上次写入不一致，停止覆盖并请求人工处理。
- **验证证据不足：** 将 Worker 上报的 `completed` 降级为 `needs_verification`，并写明缺失证据。
- **Worktree 删除：** 依赖 common-dir 中的事件继续恢复；若任务未产生结束事件，则保留异常活跃状态并提示核对。
- **Skill 或脚本失败：** 不影响已经完成的业务代码，但任务状态标记为“同步失败/待汇总”，不得声称项目文档已经更新。

## 13. 最小实现组件

```text
.codex/skills/dkagent-project-manager/
├── SKILL.md
├── scripts/
│   └── project-events.mjs
└── references/
    └── document-contracts.md
```

- `SKILL.md`：语义工作流、优先级、证据边界和写入权限。
- `project-events.mjs`：只负责 Git/Worktree 发现、事件原子写入、锁、幂等和状态文件；不判断业务优先级。
- `document-contracts.md`：三份文档的固定结构和字段约束，避免主 Skill 过长。

实现必须使用官方 `skill-creator` Skill 创建和验证，不手工假设 Skill 结构。

## 14. 验证方案

### 14.1 确定性测试

1. 三个临时 Worktree 同时追加不同任务，事件均完整保留。
2. 两个事件使用相同 `eventId`，只处理一次。
3. 两个 Worktree 认领相同 `taskId`，产生冲突且不覆盖。
4. 汇总锁被占用时，事件保持 pending。
5. 管理 Worktree 分支不匹配或文档哈希改变时拒绝写入。
6. Worktree 删除后，common-dir 中的事件仍可读取。
7. 不含有效证据的完成事件被降级为 `needs_verification`。

### 14.2 Skill 场景验证

1. Agent 开始一个 BACKLOG 任务，自动记录活跃 Worktree。
2. Agent 完成并验证任务，自动更新 STATUS 和 BACKLOG。
3. Agent 发现无关死代码，只新增待办，不擅自删除。
4. Agent 请求删除或延期待办时，必须暂停并询问用户。
5. 长测试日志只保留命令、退出码和摘要，不进入事件或文档。

### 14.3 完成标准

- `skill-creator` 的结构校验通过。
- 辅助脚本的并发、幂等、锁和异常测试通过。
- 三 Worktree 演练能汇总完整状态且无文档覆盖。
- `git diff --check` 通过。
- 未执行真实多 Worktree 演练时，只能报告“结构/单测验证通过”，不能报告并行场景已验证。

## 15. 实施顺序

1. 使用 `skill-creator` 创建 Skill 骨架和约束。
2. 创建三份项目文档的初始结构，并在 `AGENTS.md` 接入强制收尾协议。
3. 实现并测试共享事件与锁的最小脚本。
4. 实现 Worker 与 Project Manager 两种工作流。
5. 使用临时 Worktree 做三路并行演练。
6. 根据演练结果收紧冲突与恢复规则，不扩展到外部任务服务。
