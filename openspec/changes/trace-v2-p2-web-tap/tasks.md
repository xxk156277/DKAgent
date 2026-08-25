## 1. Trace Reader

- [x] 1.1 先写失败测试，再增加 Session TraceSummary 查询、100 条上限和 Session Trace 存在性读取
- [x] 1.2 抽取共享 TraceDocument 构建与完整性诊断，并保持 CLI show 行为通过

## 2. Web API V2

- [x] 2.1 先写失败测试，再实现 Session traces、Trace document 与 SpanChange SSE 三个接口
- [x] 2.2 删除 V1 Event API，并验证 404、安全 500、断开订阅与 Tap 故障隔离

## 3. Web Store 与实时合并

- [x] 3.1 先写失败测试，再迁移 TraceSummary/TraceDocument 选择状态和 followLive 行为
- [x] 3.2 实现 SSE 先连接后补读、按 revision 合并、身份保护和重连补读

## 4. Typed Span 投影与界面

- [x] 4.1 先写失败测试，再实现 projectSpans、Step/Turn 分组、直接/子树 Token 和自身耗时
- [x] 4.2 迁移节点详情、Context 指标与 Agent 指标，删除 V1 类型、投影和夹具
- [x] 4.3 验证空 Session、历史 Trace、错误/running Span 与移动端基本展示

## 5. 验收

- [x] 5.1 通过 Trace、Agent、Web 全量测试与 typecheck、Web build、git diff --check 和 OpenSpec strict validate
- [x] 5.2 运行 test2.md，验证 Web 与 trace show --json 的 Trace、Span、revision、状态、Token、耗时和完整性一致
- [x] 5.3 验证 model.generate 输入输出不脱敏，并在 SQLite 重启后原样恢复；模型错误仍只保存安全字段
