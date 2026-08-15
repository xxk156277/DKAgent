# Session 小幅完善设计

## 目标

在现有 Session 持久化基础上，补齐最小的会话管理能力：列出、切换和删除 Session。

本阶段只完善常规 Session 使用闭环，不引入状态机、Checkpoint、分支、事件回放或 Memory。

## 设计原则

1. 采用 Pi 的运行时替换思路：CLI 外壳和 `SessionStore` 保留，切换时重建 `AgentLoop`。
2. 先成功加载目标 Session，再替换当前 `AgentLoop`，避免加载失败破坏当前会话。
3. 禁止删除当前 Session。用户必须先执行 `/new` 或 `/switch`。
4. CLI 不直接操作 SQLite，所有持久化操作通过 `SessionStore` 完成。

## 顶层数据流

```text
CLI command
    |
    v
SessionStore -----> SQLite
    |
    v
SessionSnapshot
    |
    v
new AgentLoop(snapshot)
```

切换 Session 时保留 CLI 的输入循环，只替换负责对话状态的 `AgentLoop`。

## 类型和接口

新增 Session 列表项：

```ts
interface SessionSummary {
  /** Session 的唯一标识。 */
  id: string;

  /** Session 的创建时间。 */
  createdAt: string;

  /** Session 最后一次更新的时间。 */
  updatedAt: string;
}
```

扩展 `SessionStore`：

```ts
interface SessionStore {
  /** 按更新时间从新到旧列出 Session。 */
  list(): SessionSummary[];

  /** 加载指定 Session；不存在时返回 null。 */
  load(sessionId: string): SessionSnapshot | null;

  /** 删除指定 Session；不存在时返回 false。 */
  delete(sessionId: string): boolean;
}
```

`SessionStore` 不判断“是否为当前 Session”，因为当前 Session 属于 CLI 运行时状态。该规则由 CLI 负责。

## CLI 命令

### `/sessions`

按 `updatedAt` 倒序展示所有 Session，并用 `*` 标记当前 Session。

```text
* abc123  2026-08-15 10:00
  def456  2026-08-14 18:00
```

### `/switch <sessionId>`

```text
读取目标 Session
  -> 不存在：提示错误，当前 AgentLoop 不变
  -> 已经是当前 Session：提示用户，不重建 AgentLoop
  -> 加载成功：基于快照创建新 AgentLoop，再替换当前引用
```

伪代码：

```ts
const snapshot = sessionStore.load(sessionId);

if (!snapshot) {
  showError("Session 不存在");
  return;
}

if (snapshot.id === currentSession.id) {
  showInfo("已经是当前 Session");
  return;
}

const nextAgentLoop = createAgentLoop(snapshot);
currentSession = snapshot;
agentLoop = nextAgentLoop;
```

### `/delete <sessionId>`

```text
目标是当前 Session：拒绝，提示先 /new 或 /switch
目标不存在：提示未找到
其他 Session：删除 Session 及其关联消息
```

CLI 必须在调用 `SessionStore.delete()` 前完成当前 Session 判断。

## 数据库行为

- `list()` 只读取 Session 元数据，不加载消息正文。
- `load()` 读取 Session 元数据、消息和上下文状态，组装完整 `SessionSnapshot`。
- `delete()` 删除 Session 及其关联消息。
- 删除操作需要保持原子性，避免只删除 Session 或只删除消息。

## 错误边界

| 场景 | 行为 |
| --- | --- |
| `/switch` 缺少 ID | 输出命令用法 |
| `/switch` ID 不存在 | 提示未找到，当前 Loop 不变 |
| `/switch` 当前 ID | 提示已经是当前 Session |
| `/delete` 缺少 ID | 输出命令用法 |
| `/delete` ID 不存在 | 提示未找到 |
| `/delete` 当前 ID | 拒绝删除 |

数据库异常不伪装成“未找到”，继续向上抛出，由现有 CLI 顶层错误处理负责展示。

## 验证范围

Store 测试：

- `list()` 按更新时间倒序返回元数据。
- `load()` 能恢复完整快照，不存在时返回 `null`。
- `delete()` 删除 Session 和关联消息，不存在时返回 `false`。

CLI 测试：

- `/sessions` 标记当前 Session。
- `/switch` 成功后后续消息写入目标 Session。
- `/switch` 失败时当前 AgentLoop 不变。
- `/delete` 拒绝删除当前 Session。
- `/delete` 可以删除非当前 Session。

## 明确不做

- Session 名称和重命名。
- 消息数、Token 和成本统计。
- Session 状态机。
- Checkpoint、回滚、分支和事件回放。
- Memory 提取和向量检索。
