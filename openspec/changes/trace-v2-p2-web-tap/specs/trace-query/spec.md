## ADDED Requirements

### Requirement: Reader lists bounded Trace summaries by Session
Trace Reader SHALL 按 sessionId 返回 startedAt 倒序的 TraceSummary，调用方可指定上限且任何一次查询不得超过 100 条；空 Session SHALL 返回空数组。

#### Scenario: List newest Session Traces
- **WHEN** 一个 Session 存在超过一条 Trace 且 Reader 查询该 sessionId
- **THEN** Reader 返回最多指定数量的 TraceSummary，并按 startedAt 从新到旧排序

#### Scenario: Session has no Trace
- **WHEN** Reader 查询不存在 Trace 的 sessionId
- **THEN** Reader 返回空数组且不读取其他 Session 的 Trace

### Requirement: Web and CLI share canonical TraceDocument semantics
Web Tap 与 CLI SHALL 使用 Trace 包提供的同一 canonical TraceDocument 构建和完整性诊断语义，且单个 Document 最多包含 1000 个 Span。

#### Scenario: Same Trace is read by Web and CLI
- **WHEN** Web API 与 CLI JSON 读取同一个 traceId
- **THEN** 两者返回相同的 traceId、spanId、revision、状态、Token、耗时、顺序和完整性诊断

