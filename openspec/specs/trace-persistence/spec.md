# trace-persistence Specification

## Purpose

为 DKAgent Typed Span 提供本地、可重启恢复且不影响 Agent 业务结果的 SQLite 持久化能力，并保持 Session、Trace 与 Span 的可靠归属关系。

## Requirements

### Requirement: Typed Span survives process restart
系统 SHALL 将普通 Agent 与 Observe 产生的 canonical Typed Span 默认写入 `.dkagent/sessions.db`，并在进程关闭后重新打开数据库时恢复同一 traceId、spanId、revision、状态、输入、输出、Token 和耗时。

#### Scenario: Restore a completed Trace
- **WHEN** 一个 Agent Turn 正常结束且进程关闭后重新打开 Trace Reader
- **THEN** Reader 返回与写入时相同 traceId 的 terminal Span 快照

### Requirement: Trace uses normalized Session relationships
系统 SHALL 使用 `sessions 1:N traces 1:N trace_spans` 关系保存 Trace，且 SHALL NOT 在 `trace_spans` 冗余 `session_id`。

#### Scenario: Delete a Session
- **WHEN** 一个 Session 被删除
- **THEN** 数据库通过外键级联删除该 Session 的全部 Trace 和 Span

#### Scenario: Read spans by Session
- **WHEN** Reader 按 sessionId 查询 Span
- **THEN** Reader 通过 `traces.session_id` 返回该 Session 的 Span

### Requirement: Higher revision wins
系统 SHALL 仅接受同一 spanId 的更高 revision 快照，并 SHALL 保持 traceId、parentSpanId、name、kind、sequence 等身份字段不变；terminal Span SHALL NOT 被迟到的 running 快照覆盖。

#### Scenario: Stale snapshot arrives after terminal
- **WHEN** Store 已保存 terminal revision，随后收到更低或相同 revision 的 running 快照
- **THEN** Store 保留 terminal revision 且不发布新的订阅通知

#### Scenario: Higher revision changes identity
- **WHEN** 更高 revision 快照改变任一 Span 身份字段
- **THEN** Store 拒绝该快照并保留原数据

### Requirement: Subscribers observe committed data
系统 SHALL 在 SQLite 事务成功提交后才发布 SpanChange，并 SHALL 隔离每个订阅者的异常和对象修改。

#### Scenario: Subscriber reads after notification
- **WHEN** 订阅者收到 span_ended 通知并立即读取该 Span
- **THEN** Reader 已能返回相同或更高 revision 的 terminal 快照

#### Scenario: One subscriber fails
- **WHEN** 一个订阅者抛出异常或修改收到的对象
- **THEN** 其他订阅者仍收到未被污染的 SpanChange，Agent 业务结果保持不变

### Requirement: Trace persistence is passive
序列化、SQLite、外键、Sink 或监听器故障 MUST NOT 改变 Agent 的业务返回值或原始异常；连续写故障 SHALL 通过既有 onWriteError 语义告警，并在成功写入后复位。

#### Scenario: Database write fails after business success
- **WHEN** Agent 回调成功但 SQLite 写入失败
- **THEN** Agent 仍返回原业务结果且故障通过 Trace 错误出口可见

#### Scenario: Tap startup fails
- **WHEN** Observe 无法启动 Tap Server
- **THEN** Agent 继续运行并仍将后续 Trace 写入 SQLite

### Requirement: Unsupported data does not enter the canonical write path
系统 SHALL 拒绝未知 schemaVersion、Span name 或 kind 的写入；读取到不支持的持久化版本时 SHALL 明确报告“不支持”，不得静默猜测或转换。

#### Scenario: Unknown schema is written
- **WHEN** Store 收到 schemaVersion 非 2 的运行时快照
- **THEN** Store 不保存该快照且不调用订阅者

#### Scenario: Unknown schema exists on disk
- **WHEN** Reader 读取到未知 schemaVersion 的 Span 行
- **THEN** Reader 返回明确的不支持错误
