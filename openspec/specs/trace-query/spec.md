# trace-query Specification

## Purpose

为开发者和 Codex 提供有界、只读且格式稳定的 Trace 定位与回放能力，使 badcase 能通过 recent 到 show 的固定链路完成诊断。

## Requirements

### Requirement: Recent returns bounded Trace summaries
系统 SHALL 提供 `npm run trace -- recent`，按 startedAt 从新到旧返回最近 TraceSummary，默认最多 10 条且任何一次查询不得超过 100 条。

#### Scenario: List recent Traces after restart
- **WHEN** 进程重启后执行 `npm run trace -- recent`
- **THEN** CLI 返回最近 Trace 的 traceId、sessionId、状态、开始/结束时间、耗时、Span 数和完整性

### Requirement: Show returns a canonical TraceDocument
系统 SHALL 提供 `npm run trace -- show <traceId> [--json]`，返回 schemaVersion 2 的 TraceDocument，并按 sequence 升序包含最高 revision 的完整 Typed Span。

#### Scenario: Show a completed Trace as JSON
- **WHEN** 使用已存在的 traceId 执行 `show <traceId> --json`
- **THEN** stdout 只输出可被 JSON.parse 的 TraceDocument，且 Span 顺序、状态、Token 与数据库一致

#### Scenario: Trace does not exist
- **WHEN** 使用不存在的 traceId 执行 show
- **THEN** CLI 返回非零退出码和明确的 Trace 不存在错误

### Requirement: TraceDocument reports integrity diagnostics
TraceDocument SHALL 包含 `complete` 和诊断结果，至少识别 missingRoot、missingParent、running、outputMissing、serializationError；Reader SHALL NOT 猜测缺失的业务结果。

#### Scenario: Complete terminal Trace
- **WHEN** Trace 有唯一 agent.turn 根、所有父节点存在、所有 Span terminal 且无完整性事件
- **THEN** TraceDocument 的 complete 为 true，全部诊断集合为空

#### Scenario: Incomplete persisted Trace
- **WHEN** Trace 存在 running Span、缺父节点、trace.output_missing 或 trace.serialization_error
- **THEN** complete 为 false，相关诊断包含对应 spanId

### Requirement: Query surface is read-only and bounded
CLI SHALL 只提供预定义 recent/show 查询，SHALL NOT 接受任意 SQL、无界 list 或写入命令。

#### Scenario: User passes an unsupported command
- **WHEN** 用户执行未定义命令或缺失必需参数
- **THEN** CLI 返回非零退出码并显示有限命令用法，不执行数据库写入
