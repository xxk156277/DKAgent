# DKAgent Tap 最小观测界面设计

## 1. 目标

为 DKAgent 增加一个本地、只读、与模型厂商无关的运行观测界面。

第一版必须能回答三个问题：

1. 当前一轮对话经历了哪些 Agent Step、Tool Call 和 Tool Result？
2. 每次模型调用实际使用了哪些消息和 Tool Schema？
3. ContextManager 是否触发裁剪，裁剪前后有什么变化，Token 预算是多少？

参考 Claude Tap 的 trace viewer 思路，但不实现 HTTP 代理。DKAgent 通过与观测产品无关的运行时事件端口暴露内部语义；Tap 只作为外部订阅者接入。

## 2. 范围

### 包含

- DKAgent 继续在终端交互。
- 浏览器实时展示当前进程产生的 trace。
- Trace 追加写入本地 JSONL，刷新页面后仍可读取本次及历史运行。
- 按轮次和 Agent Step 展示 User、Assistant、Tool Call、Tool Result。
- 展示模型请求的原始 JSON。
- 展示 ContextManager 构建前后的消息 Diff、Token 预算和删除数量。
- 展示运行错误，不影响 DKAgent 原有错误处理。

### 不包含

- 在网页中发起对话。
- 登录、权限、多人协作和远程访问。
- 数据库、云端存储和跨机器同步。
- 模型名称、厂商、费用和性能排行。
- 通用代理抓包、HTTPS 证书或协议适配。
- 复杂图表、搜索和 Trace 导出。
- 对 Tool Result 做语义摘要。

## 3. 总体架构

```text
DKAgent Core
   │ emit(RuntimeEvent)
   ▼
RuntimeEventSink（中立端口）
   │
   └── Tap Adapter ── append ──> .traces/*.jsonl
             │
             └── publish ──────> SSE ──> 本地 Web Viewer
                                      ├── 左：轮次 / Step 时间线
                                      ├── 中：对话 / Tool 链
                                      └── 右：JSON / Context Diff
```

依赖方向固定为 `Tap -> RuntimeEventSink <- Agent Core`。Agent Core 不允许导入 Tap 模块、HTTP Server、Recorder 或 Viewer。删除整个 Tap 模块后，Agent Core 仍应正常编译和运行。

观测器只能接收事件，不能修改 AgentLoop、ContextSnapshot 或 Tool 执行结果。即使观测服务启动失败，DKAgent 主流程仍应继续运行。

## 4. 模块边界

### 4.1 RuntimeEventSink

`RuntimeEventSink` 是 Agent Core 唯一知道的观测边界，放在中立的 runtime 目录，而不是 Tap 目录：

```ts
interface RuntimeEventSink {
  emit(event: RuntimeEvent): void;
}
```

Agent Core 通过构造参数接收可选的 sink。未提供时使用 No-op 实现，因此观测能力不成为 Agent 的启动条件。

### 4.2 RuntimeEvent

统一事件信封：

```ts
interface RuntimeEvent<TPayload = unknown> {
  id: string;
  sessionId: string;
  turnId: string;
  step?: number;
  sequence: number;
  timestamp: string;
  type: RuntimeEventType;
  payload: TPayload;
}
```

事件类型保持最少：

| 事件 | 作用 |
| --- | --- |
| `turn.start` | 记录用户输入和新一轮开始 |
| `context.before` | 记录完整历史、System Prompt、Tool Schema 和预算输入 |
| `context.after` | 记录最终快照、Token 统计和被删除消息 |
| `model.response` | 记录文本响应或 Assistant Tool Call |
| `tool.call` | 记录 Tool 名称、参数和 toolCallId |
| `tool.result` | 记录 Tool 结果、耗时或错误 |
| `turn.end` | 记录最终回答和轮次完成 |
| `turn.error` | 记录失败阶段和错误消息 |

`context.before` 和 `context.after` 必须共享同一个 `turnId + step`，前端据此生成 Diff。

这些事件描述 Agent 运行事实，不包含 `tap`、页面布局、HTTP 或存储等观测产品概念。

### 4.3 Tap Adapter 与 TapRecorder

Tap Adapter 实现 `RuntimeEventSink`，把通用事件交给 TapRecorder。Agent Core 不知道是否存在订阅者，也不等待订阅者处理结果。

职责只有两个：

- 将每个事件序列化为单行 JSON 并追加到当前 session 文件。
- 将同一事件发布给已经连接的 SSE 客户端。

写文件或推送失败只记录警告，不向 Agent 主流程抛错。

### 4.4 TapServer

使用 Node 内置 HTTP 能力，避免引入 Web 框架。只提供：

- `GET /`：返回单页 Viewer。
- `GET /api/events`：读取当前 session 的全部事件。
- `GET /api/events/stream`：通过 SSE 推送新事件。

服务只绑定 `127.0.0.1`，默认端口固定；端口冲突时输出警告并关闭观测功能，不中断 DKAgent。

### 4.5 Viewer

使用一份原生 HTML、CSS、JavaScript，不引入 React 和构建工具。

- 左栏：按 `turnId` 分组，显示轮次、Step、成功或失败状态。
- 中栏：按顺序展示 User、Assistant、Tool Call、Tool Result 卡片。
- 右栏：展示选中事件的格式化 JSON。
- 选中 `context.after` 时，右栏额外展示：
  - `estimatedInputTokens / availableInputTokens`；
  - `droppedMessageCount`；
  - Before 与 After 消息列表；
  - 被删除消息高亮。

Diff 第一版按消息稳定标识或结构化内容比较，不做字符级文本 Diff。

## 5. 数据流

1. 组合根按启动参数决定是否创建 Tap Adapter，并以 `RuntimeEventSink` 注入 AgentLoop。
2. CLI 收到用户输入，AgentLoop 创建 `turnId` 并向 sink 发送 `turn.start`。
3. 每个 Agent Step 调用 ContextManager 前发送 `context.before`。
4. ContextManager 返回 ContextSnapshot 后发送 `context.after`。
5. 模型返回后发送 `model.response`。
6. 若模型请求 Tool，则分别在执行前后发送 `tool.call`、`tool.result`，随后进入下一 Step。
7. 得到最终文本时发送 `turn.end`；任一阶段失败时发送 `turn.error`。
8. Tap Adapter 收到事件后，由 TapRecorder 同时写 JSONL 和推送 SSE；Viewer 首次加载读取历史，之后只追加实时事件。

## 6. Context Diff 数据要求

当前 `ContextSnapshot` 只有最终消息和 `droppedMessageCount`，无法直接解释具体删除了什么。最小改动是在观测层用 `context.before.messages` 与 `context.after.messages` 计算被删除消息，不改变 ContextManager 的裁剪算法和公开返回结构。

比较时必须保持 Tool Call 与 Tool Result 的完整组结构。Viewer 将一个 Tool Exchange 视为同一个不可拆分节点，避免误导用户认为只删除了半条工具链。

## 7. 错误与隐私

- Trace 可能包含完整对话、System Prompt、Tool 参数和 Tool Result，只保存在 DKAgent 项目本地。
- Viewer 不监听局域网地址。
- 不记录 API Key、请求 Header 和环境变量。
- 无法序列化的 payload 以错误占位事件替代，不能导致 Agent 失败。
- 浏览器断开后不缓存待推送事件；重连时重新读取 JSONL 补齐。

## 8. 验证

### 自动测试

- 事件 sequence 严格递增，轮次和 Step 关联正确。
- Recorder 输出合法的逐行 JSON。
- Recorder 写入失败时 Agent 仍可完成回答。
- Context 前后事件能识别被删除的普通消息。
- Tool Call 与 Tool Result 不会在 Diff 中被拆散。
- SSE 客户端能收到新事件。
- Agent Core 的源码不能导入 Tap 模块。
- 不注入 `RuntimeEventSink` 时，Agent 原有测试和运行行为保持不变。
- Tap Adapter 抛错时，Agent 仍可完成回答。

### 最小人工验收

1. 启动 DKAgent 和 Viewer。
2. 连续进行至少两轮对话，其中一轮触发 Tool。
3. 使用较小 Token 预算触发一次上下文裁剪。
4. 浏览器能看到轮次时间线、Tool 链、原始 JSON，以及裁剪前后差异。
5. 关闭浏览器后 DKAgent 仍可继续对话；重新打开页面能恢复已有 trace。

## 9. 完成标准

- 一个可选命令启动 DKAgent 和 Viewer；原有 Agent 启动命令仍可独立运行。
- 不修改 DKAgent 的模型选择和 Tool 行为。
- Agent Core 不依赖任何 Tap 实现、存储或 Web 模块。
- 页面能实时显示完整事件顺序。
- 能明确指出一次 Context 构建是否发生裁剪、删除了哪些消息、前后 Token 情况。
- 观测模块失败不会阻塞 Agent 主流程。
