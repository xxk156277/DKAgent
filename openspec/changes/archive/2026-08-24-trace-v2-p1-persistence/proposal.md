## Why

Trace V2 当前只保存在进程内存中，Codex 无法在 DKAgent 退出或重启后回溯 badcase。P1 需要把 canonical Typed Span 写入 Session 共用的 SQLite，并提供有界、稳定的查询入口。

## What Changes

- 新增 SQLite Trace Store，在 `.dkagent/sessions.db` 中使用 `traces`、`trace_spans` 两表持久化最高 revision 的 Typed Span 快照。
- Session 删除时通过两级外键级联删除关联 Trace 和 Span。
- 新增 `TraceSummary`、`TraceDocument` 与完整性诊断，报告缺根、缺父、running、缺输出和序列化降级。
- 新增 `npm run trace -- recent` 与 `npm run trace -- show <traceId> [--json]`，不开放任意 SQL。
- 普通 Agent 与 Observe 默认使用同一个 SQLite Trace Store；Tap 启动失败不停止 Agent 或 Trace 持久化。
- 不迁移 V1 Event 数据，不实现 Web Tap V2、采样、成本、保留任务或第三方导出。

## Capabilities

### New Capabilities

- `trace-persistence`: 定义 Typed Span 的 SQLite 表、revision 合并、Session 级联、重启恢复和被动故障隔离。
- `trace-query`: 定义 TraceSummary、TraceDocument、完整性诊断以及 recent/show CLI 行为。

### Modified Capabilities

无。

## Impact

- `packages/trace`：新增 SQLite Store、Reader、Document codec 和 CLI。
- `packages/agent`：普通 CLI 组合根默认创建并关闭 SQLite Trace Store。
- `packages/web-tap`：Observe 组合根改为共享 SQLite Trace Store，但本阶段不迁移 V1 Web 投影/API。
- 根 `package.json`：新增 `trace` 命令。
- 依赖：`@dkagent/trace` 正式声明现有 `better-sqlite3` 运行时依赖。
