## Context

P0 已产生 schemaVersion 2 的 canonical Typed Span，并通过同步 `TraceSink.upsert()` 写入内存 Store。当前普通 Agent 默认创建无 Sink 的 Tracer，Observe 使用 MemoryTraceStore；进程结束后 Trace 丢失。现有 Session Store 已使用 `better-sqlite3`、WAL 和 `.dkagent/sessions.db`。数据库 ER 细节见 `packages/trace/TRACE-V2-MVP-DATABASE-ER.md`。

P2 Web Tap V2 尚未开始，因此本阶段只保证 Store、Reader、CLI 和组合根；旧 Web 投影无法正确解释 Typed Span 是已知基线，不在 P1 顺手修复。

## Goals / Non-Goals

**Goals:**

- 在共享 Session SQLite 中可靠保存每个 Span 的最高 revision。
- 让 Codex 在进程重启后通过 recent → show 回放同一 Trace。
- 保持 Trace 写入、查询和 Tap 故障不影响 Agent。
- 为 P2 提供唯一的 TraceSummary/TraceDocument codec。

**Non-Goals:**

- 不迁移 Web API、SSE 或 React 投影。
- 不迁移 V1 Event 数据，不提供任意 SQL。
- 不实现采样、成本、保留期、归档、OTel 或第三方导出。

## Decisions

### 1. 使用规范化的三层关系

采用 `sessions → traces → trace_spans`。`session_id` 只存在于 `traces`，Span 通过 traceId 归属 Session。相比在每个 Span 冗余 sessionId，该方案避免两个 Session 事实不一致，并允许 Session 删除通过两级外键完成。

`trace_spans.parent_span_id` 不建立自外键。父写入失败时仍应允许保存可诊断的子 Span，由 TraceDocument 报告 missingParent；否则数据库会把可回溯证据一起拒绝。

### 2. SQLite Store 同时承担同步 Sink 与有界 Reader

新增一个同步 SQLite Store，实现现有 TraceStore，并增加 recent/getTraceDocument 读取能力。每次 upsert 使用短事务：校验运行时值、读取当前 revision、验证身份、更新 traces/trace_spans、提交，最后发布 defensive-cloned SpanChange。

选择同步写是因为当前 Tracer 和 Agent 边界均为同步被动出口，MVP 不引入队列、flush worker 或异步关闭协议。SQLite WAL 降低 Session 与 Trace 两个连接之间的读写阻塞。

### 3. Trace 行保存根摘要，Span 行保存 canonical JSON

`traces` 保存 recent 所需的根状态和完整性；`trace_spans` 使用 REAL duration_ms，并把 input/output/error/tokenUsage/attributes/events 保存为 JSON TEXT。写入只接收已经通过 P0 JSON-safe 和 Typed Span 校验的数据；读取仍重新校验 schema/name/kind，防止磁盘损坏或未来版本被误解释。

TraceDocument 最多读取 1000 个 Span，并与 traces 中的 spanCount 对比；超过边界时明确判为不完整，不提供无界查询。

### 4. TraceDocument 是 CLI 与未来 Web 的唯一读取格式

TraceDocument 固定包含 `schemaVersion: 2`、TraceSummary、按 sequence 排序的 spans、complete 和 diagnostics。complete 只有在唯一根、无缺父、无 running、无 output_missing/serialization_error 且 integrity=true 时成立。

CLI `--json` 直接序列化 TraceDocument，不做另一套投影。文本 show 也只从 TraceDocument 渲染，防止 CLI 与未来 Web 对同一 Trace 得出不同事实。

### 5. 组合根明确资源所有权

普通 `runAgentCli()` 先打开 Session Store，再打开同路径 SQLite Trace Store，并创建共享 Tracer 注入 QueryEngine、Context、Memory、Artifact、AgentLoop；由 CLI 在输入循环结束后关闭自己创建的 Trace Store。

Observe 由外层创建 Session Store、SQLite Trace Store 和 Tracer，再同时交给 Tap 与 Agent。Tap 启动失败时仍把同一 Tracer 交给 Agent。关闭时先停止 Agent 新写入，再关闭 Tap/SSE，最后 checkpoint 并关闭 Trace 和 Session SQLite 连接。注入资源由调用者关闭，callee 不重复关闭。

## Risks / Trade-offs

- **[同步 SQLite 增加 Turn 延迟]** → 单次只 upsert 一行且使用 WAL；MVP 先以可靠回溯为目标，不引入队列。
- **[Session 与 Trace 使用两个连接]** → 每个连接都开启 foreign_keys/WAL，并通过明确关闭顺序避免 checkpoint 竞态。
- **[进程被强杀会留下 running Span]** → 保留真实 running 快照，由 TraceDocument 标记 complete=false，不伪造 error。
- **[数据库出现未知或损坏行]** → Reader 明确报告不支持或损坏，不静默丢弃后继续声称完整。
- **[旧 Web Tap 展示错误]** → P1 只保证 SQLite 和 CLI；Web V2 在 P2 统一消费 TraceDocument。

## Migration Plan

1. 新增表使用 `CREATE TABLE IF NOT EXISTS`，不修改现有 Session/Message 数据。
2. 普通 Agent 首次启动时自动创建 Trace 表并开始写 V2 Span。
3. 不读取或转换 V1 Event 持久化实验数据。
4. 回滚时停止创建 SQLite Trace Store；新增表可保留，不影响 Session Store。
