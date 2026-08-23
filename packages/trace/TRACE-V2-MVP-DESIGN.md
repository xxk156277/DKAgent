# Trace V2 MVP：可执行方案

## 1. 目标与边界

Trace V2 为普通 Agent 请求提供 canonical typed trace：可关联、可脱敏、可按 revision 恢复，并且观测故障不改变业务结果。目标架构为：

`Agent → Tracer → SQLite Sink ← Observe(Tap/CLI/Web)`

普通 Agent 与 Observe 默认共享 `.dkagent/sessions.db` SQLite 文件和 Tracer 写侧契约。Observe 创建共享 TraceStore + Tracer；Tap 启动失败仍使用该 Tracer 落库，资源由所有者按关闭顺序释放。Trace Sink、Tap、Listener 都是同步被动出口，写入/推送失败只触发隔离回调。当前代码阶段已实现内存写侧；SQLite、CLI、Web 和 Agent 迁移按路线逐步实现。

SpanName 仅有：`agent.turn`、`agent.step`、`context.build`、`context.compact`、`model.generate`、`tool.execute`、`memory.recall`、`memory.extract`、`memory.write`、`artifact.put`、`artifact.get`。未知 name/schema 不进入写侧。

不引入 OTel、采样、成本、评测或第三方 Trace 协议；不保留 V1 lifecycle-event、Skill 节点或 Context diff。

## 2. Canonical Span 与内容边界

```ts
type AnyTraceSpan = { [N in SpanName]: TraceSpan<N> }[SpanName]
```

每个 Span 快照包含 `traceId/spanId/parentSpanId/sessionId/name/kind/status/sequence/revision/startedAt/endedAt/durationMs/input/output/error/tokenUsage/attributes/events/integrity`。sequence 是 Trace 内创建顺序，event sequence 是 Span 内顺序；revision 从 1 开始递增，Store 忽略 stale/equal revision。

| Span | input → output |
| --- | --- |
| agent.turn | `{userInput}` → `{answer}` |
| agent.step | `{step}` → `{outcome,stopReason,toolCallCount}` |
| context.build | message/tool 计数、token 预算、compaction 决策 → 计数/预算结果 |
| context.compact | 调用前 message/token/decision → 前后消息与 token、summarized/retained、fallback |
| model.generate | 实际 provider/model/messages/tools 请求 → text 或 tool_use 响应；tokenUsage 仅此 Span |
| tool.execute | `{toolCallId,name,input}` → `{success,data?,error?}` |
| memory.recall | query → 脱敏后的 content/characterCount |
| memory.extract/write | 真实候选/写入内容 → 候选或保存结果 |
| artifact.put/get | ID/type/metadata → ID/hit；不保存大对象 |

Context 只保存 DTO；完整 messages/tools 只进入 model.generate.input。Memory 内容递归脱敏但保留 recalled memory 普通文本。credential key 规范化后精确匹配 authorization/header(s)/env/environment/password/secret/token/accessToken/refreshToken/bearerToken/clientSecret，或以 `apikey` 结尾；`inputTokens/outputTokens/maxContextTokens` 不脱敏。

## 3. 生命周期、完整性与隔离

`trace()` 只能创建 agent.turn 根，active Trace 内拒绝嵌套根；`span()`/`spanSync()` 无 active Trace 时执行业务回调但不记录，active 时继承 trace/session 并建立 parent。model.generate 错误只存安全 `name/code`，祖先 Span 对同一 Provider 异常也不保存 raw message，原异常 identity 原样抛回。

正常成功但未 setOutput：`status=ok`、`output=null`、`integrity=false` 并写 `trace.output_missing`。业务异常：`status=error`，不因为 output=null 伪造 output_missing。输入、输出、attributes、event、tokenUsage 的 JSON-safe clone 遇 `undefined/BigInt/function/symbol/Map/class/非有限数/循环/Proxy trap/深度溢出` 时写 null/marker 和 `trace.serialization_error`，`integrity=false`；最终快照必须可 JSON.stringify。Sink、Listener、onWriteError、Tap 异常均隔离。

`spanSync` 回调返回 PromiseLike 是编程错误：先挂 catch 防止 unhandled，再记录 error 并抛出；同步副作用返回前完成。Span 终态后 escaped handle 的 event/output/tokenUsage 均 no-op。

## 4. 持久化与读取契约

SQLite 精确使用 `traces`、`trace_spans` 两张核心表：

- `traces`: `trace_id PK`、`session_id REFERENCES sessions(id) ON DELETE CASCADE`、`root_span_id`、`started_at`、`ended_at`、`status`、`revision`、`integrity`、`created_at`。
- `trace_spans`: `span_id PK`、`trace_id REFERENCES traces(trace_id) ON DELETE CASCADE`、`parent_span_id`、`session_id`、`name`、`kind`、`status`、`sequence`、`revision`、`started_at`、`ended_at`、`duration_ms REAL`、JSON input/output/error/token_usage/attributes/events、`integrity`；session 归属通过 trace 关系级联清理。

数据库开启 WAL；单次 upsert 在事务内按 spanId 合并，仅接受更高 revision 且 identity 不变的快照。关闭顺序为停止新写入 → flush/commit → 关闭 Tap/SSE → 关闭 SQLite；失败不得回写 Agent。

`TraceSummary` 最小字段为 traceId/sessionId/root status/startedAt/endedAt/duration/spanCount/integrity。`TraceDocument` 包含 summary、完整 spans、`complete`，以及 `missingRoot`、`missingParent`、`outputMissing`、`serializationError` 诊断；running trace 可以是 complete=false，读取层不猜测业务结果。

## 5. CLI 与 Web

CLI 精确提供：

- `npm run trace -- recent`：按开始时间返回有界 TraceSummary。
- `npm run trace -- show <traceId> [--json]`：返回 TraceDocument，按 sequence/revision 展示。

Web 精确提供三个 API：`GET /api/sessions/:sessionId/traces`、`GET /api/traces/:traceId`、`GET /api/traces/stream`。SSE 以 `(spanId,revision)` 合并，乱序或 stale 不覆盖新快照；`projectSpans` 只投影 canonical spans，Context 指标单独投影，不恢复完整上下文。CLI 与 Web 必须共享同一 Reader/Document codec，确保查询一致。

## 6. WIP=1 路线与验收

路线严格 WIP=1：

1. P0：内存 Typed Span，以及 Agent/Context/Memory/Artifact/Interview/CLI composition root 的迁移；门槛是 Trace tests、typecheck、diff-check 和组合根启动验收全绿。
2. P1：SQLite Sink、TraceDocument 与 Codex CLI；门槛是进程重启后 recent/show、revision/完整性诊断与 JSON codec 验收。
3. P2：Web Tap V2；门槛是三个 API、SSE revision merge、Tap 故障隔离与 Web/CLI JSON 一致。

`test2.md` 精确验收链：`agent.turn → agent.step → model.generate → tool.execute(read_file) → agent.step → model.generate`；每个 model Span 校验 Provider、token usage 和耗时，Memory 模型调用同样记录为 model.generate。进程重启后执行 `recent → show` 并确认仍为同一 Trace；最后比较 Web 与 CLI 的 JSON 一致性。

## 7. 原功能影响

| 子系统 | 影响与保持项 |
| --- | --- |
| text/stream | text 与 stream 业务结果保持；turn/model 快照记录实际请求与响应 |
| tool pairing | Tool Call/Result pairing 保持协议完整，tool.execute 只观察不改执行顺序 |
| context | budget、group trim、summary fallback 行为保持；只写 context DTO，取消旧 diff |
| memory | recall 内容保留并按 credential key 脱敏；memory failure isolation 保持，失败不改 Agent 结果 |
| Interview | abort 与 safe error 行为保持；结构化结果继续 Zod 校验，不把原异常 message 写入 model Span |
| artifact | artifact sync 行为保持；Span 只记录 ID/type/metadata |
| session | session CRUD 与 cascade 保持；trace 通过 sessions 外键级联删除 |
| Web | static/loopback/path 行为保持；Tap V2 失败不影响共享 Tracer 落库 |
| 迁移清理 | 删除 V1 lifecycle-event；不再写 Skill 节点；普通 Agent turn 默认落库 |

当前阶段未实现的 SQLite/CLI/Web/Agent 迁移不得伪装成已验收能力。
