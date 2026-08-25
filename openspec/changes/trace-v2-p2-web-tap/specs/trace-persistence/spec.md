## ADDED Requirements

### Requirement: Model Span persists the actual request and final response
每个 `model.generate` Span SHALL 在 `input` 中保存最终提交给 Provider 适配器的完整语义请求，包括实际使用的 provider、model、messages、tools 和已设置的生成参数；成功结束时 SHALL 在 `output` 中保存最终组装的 text 或 tool_use 响应及 stop reason。模型输入输出 SHALL 不进行字段删除、内容替换或敏感信息脱敏，并 SHALL 直接随 Span 写入本地 SQLite；流式分片 SHALL NOT 代替或重复最终输出。

#### Scenario: Text generation succeeds
- **WHEN** 模型完成一次文本生成
- **THEN** terminal `model.generate` Span 原样包含该次调用的实际输入，以及最终文本、响应类型和 stop reason

#### Scenario: Tool-use generation succeeds
- **WHEN** 模型返回一个或多个 Tool Call
- **THEN** terminal `model.generate` Span 原样包含该次调用的实际输入，以及最终 tool_use 响应、完整 Tool Call 参数和 stop reason

#### Scenario: Model generation fails
- **WHEN** Provider 调用失败且没有最终模型响应
- **THEN** `model.generate.input` 仍原样保留实际请求，`output` 为空，并且 Span 仅保存安全错误名称和代码而不保存 Provider 原始错误消息

#### Scenario: Trace is restored after restart
- **WHEN** 已完成的模型 Span 落库后重启进程并通过 Trace Reader 读取
- **THEN** Reader 返回与模型调用时相同的原始模型输入和最终输出
