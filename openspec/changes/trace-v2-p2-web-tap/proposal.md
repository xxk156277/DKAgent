## Why

P1 已将 canonical Typed Span 持久化到 SQLite，并提供 Codex CLI 回放，但现有 Web Tap 仍依赖已删除的 V1 TraceEvent、request/response 双节点和内存事件流，无法可靠展示 P1 Trace。需要用最小迁移让 Web 与 CLI 读取、合并和展示同一份 TraceDocument。

## What Changes

- 为 Web Tap 增加按 Session 查询 TraceSummary、按 traceId 查询 TraceDocument 的只读接口。
- 用 `/api/traces/stream` 输出提交后的 canonical SpanChange，客户端按 `spanId + revision` 合并历史与实时快照。
- 删除全部 V1 Event API、V1 事件投影和 Context 消息 before/after Diff。
- 用 `projectSpans` 将一个 Typed Span 投影为一个节点，并展示输入输出、安全错误、事件、Token、耗时和完整性。
- 保留现有 Session 浏览、静态资源、loopback 和安全路径校验；不改 SQLite 表结构。

## Capabilities

### New Capabilities

- `trace-web-tap`: 定义 Web Tap V2 的 Trace API、实时 revision 合并、Typed Span 投影与最小诊断界面。

### Modified Capabilities

- `trace-query`: 增加供 Web 与 CLI 共用的 Session TraceSummary 查询和 canonical TraceDocument 完整性构建能力。
- `trace-persistence`: 明确 `model.generate` 必须将实际 Provider 语义请求与成功调用的最终组装响应原样写入本地 SQLite，不进行内容脱敏。

## Impact

- 影响 `packages/trace` 的只读接口与共享文档构建逻辑。
- 影响 `packages/web-tap` 的服务端路由、客户端 Store、Span 投影和界面。
- V1 `/api/events*` 与 `/api/sessions/:sessionId/events` 将直接删除，不提供兼容层。
- 不改变 Agent 执行、SQLite ER、Session CRUD 与 Memory 模块；仅补充已有模型 Span 输入输出直接落库的持久化契约。
