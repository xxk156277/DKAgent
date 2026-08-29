## Purpose

为开发者提供基于 canonical Typed Span 的本地 Web Trace 浏览与实时观测能力，并确保界面和 Codex CLI 使用同一份可验证数据。

## ADDED Requirements

### Requirement: Web exposes canonical Trace V2 APIs
Web Tap SHALL 提供 `GET /api/sessions/:sessionId/traces`、`GET /api/traces/:traceId` 和 `GET /api/traces/stream`；SHALL 删除全部 V1 Event API，且不提供兼容响应。

#### Scenario: Read Session Trace summaries
- **WHEN** 客户端请求一个 Session 的 traces 接口
- **THEN** 服务端返回该 Session 最多 100 条 startedAt 倒序的 TraceSummary

#### Scenario: Read canonical Trace document
- **WHEN** 客户端请求已存在的 traceId
- **THEN** 服务端返回 schemaVersion 2 的 canonical TraceDocument

#### Scenario: Trace is missing or unreadable
- **WHEN** traceId 不存在、数据损坏或版本未知
- **THEN** 服务端分别返回 404 或安全的 500，响应不暴露数据库细节

#### Scenario: Legacy Event API is requested
- **WHEN** 客户端请求 `/api/events`、`/api/events/stream` 或 `/api/sessions/:sessionId/events`
- **THEN** 服务端返回 404

### Requirement: Live updates merge safely by revision
Web Tap SHALL 仅在数据库提交成功后发送 SpanChange；客户端 SHALL 仅接受同一 Span 的更高 revision，拒绝身份字段变化，且历史 Document SHALL NOT 覆盖更新的实时 Span。

#### Scenario: History races with live update
- **WHEN** 客户端先收到较新 SSE Span 后又收到包含较旧 revision 的历史 Document
- **THEN** Store 保留较新 Span 快照

#### Scenario: Live snapshot changes identity
- **WHEN** 更高 revision 的 SpanChange 改变 spanId 对应的 traceId、parentSpanId、name、kind 或 sequence
- **THEN** Store 拒绝该变化并保留已有 Span

#### Scenario: SSE reconnects
- **WHEN** SSE 首次连接或断线重连
- **THEN** 客户端先建立实时连接再补读 Session 列表和当前 TraceDocument

### Requirement: Trace selection controls live following
Session 页面 SHALL 默认选择最新 Trace；手动选择历史 Trace SHALL 暂停自动跟随，重新选择最新 Trace SHALL 恢复跟随。

#### Scenario: User selects historical Trace
- **WHEN** 用户从最新 Trace 切换到历史 Trace
- **THEN** 后续新 Trace 不自动替换当前选择

#### Scenario: User returns to latest Trace
- **WHEN** 用户重新选择当前最新 Trace
- **THEN** 页面恢复自动跟随后续最新 Trace

### Requirement: One Typed Span projects to one node
Web Tap SHALL 使用 spanId 作为节点 ID，每个 canonical Span 只投影一个节点；agent.step SHALL 形成 Step 分组，Turn 直属 Span SHALL 进入 Turn 级分组，节点保持 parentSpanId 并按 sequence 排序。

#### Scenario: Tool and model spans are projected
- **WHEN** Trace 包含 model.generate 与 tool.execute Span
- **THEN** 每个 Span 各显示一个节点，不生成 request/response 或 call/result 双节点

### Requirement: Node details expose bounded diagnostics
节点详情 SHALL 展示输入、输出、安全错误、Span Event、状态、revision、开始结束时间、直接 Token、子树 Token、总耗时、自身耗时和完整性告警；running 或时间不完整时 SHALL 显示无法计算。

#### Scenario: Calculate subtree Token and self duration
- **WHEN** terminal Span 有后代模型 Token 且直接子 Span 时间区间存在重叠
- **THEN** 子树 Token 汇总当前 Span 与后代模型 Span，且自身耗时从总耗时中仅扣除直接子 Span 时间区间并集

#### Scenario: Span is incomplete
- **WHEN** Span 为 running 或缺少必要时间字段
- **THEN** 页面将相关耗时显示为未完成或无法计算，不猜测数值

### Requirement: Context and Agent panels use Span metrics
Context 页面 SHALL 仅展示消息数、Tool 数、预算、估算 Token、压缩数、fallback 和压缩前后指标；Agent 面板 SHALL 基于 Span 展示 Turn 状态、节点数量、Token、耗时、Tool 成功率和完整性，外部证据类评价继续显示待评测。

#### Scenario: Context Span is displayed
- **WHEN** context.build 或 context.compact Span 包含指标
- **THEN** 页面显示指标且不恢复完整消息 before/after Diff

