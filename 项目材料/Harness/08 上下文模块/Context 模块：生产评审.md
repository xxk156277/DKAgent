

> 配套图集：[context-diagrams.drawio](context-diagrams.drawio)（页面 01、04）。当前实现原理见 [context-learning.md](Context%20模块：学习理解.md)。

## 1. 评审结论

当前模块适合单进程学习项目和受控演示，已具备预算、摘要、兜底与 Trace 的基础闭环；尚不满足多实例、高并发、可恢复的生产 Agent 要求。

生产门槛不是“能压缩”，而是同时满足：不超限、信息不漂移、Tool 链完整、延迟成本可控、失败可恢复。

## 2. 关键问题

| 问题 | 生产影响 | 解决方案 |
|---|---|---|
| Token 近似估算 | 低估会触发 Provider 超限，高估会过早丢历史。 | 使用模型 tokenizer 或 Provider Count API；监控估算值与真实 usage 偏差。 |
| 摘要丢失与漂移 | 多次摘要后可能改变用户限制、进度和关键决定。 | 建立 Context Eval；保存摘要版本、来源边界和关键事实检查结果。 |
| 数组下标边界 | 消息插入、清理、恢复后 `firstKeptMessageIndex` 可能失效。 | 使用稳定 `messageId`、`firstKeptMessageId` 和状态版本。 |
| 并发与持久化缺失 | 同一 Session 并发请求可能互相覆盖，重启后摘要丢失。 | Session 串行队列；持久化摘要与边界；使用乐观锁或事务。 |
| Tool Result 过大 | 单个日志、搜索或数据库结果可能占满当前 Run。 | Tool 返回摘要、预览和 `artifactId`；Context 按需加载，不传完整大对象。 |
| 安全与隐私 | Prompt Injection、敏感信息可能进入摘要或 Trace。 | 摘要内容视为不可信数据；脱敏 Trace；限制长期保存字段。 |

## 3. 衡量与验收

| 指标 | 目标 |
|---|---|
| Context 超限率 | 接近 0；任何超限都可追踪原因。 |
| Tool 链完整率 | 100%，不得拆开 Tool Call/Result。 |
| 关键事实保留率 | 用固定长对话评估，覆盖目标、约束、决定和关键数据。 |
| Token 估算误差 | 持续比较估算输入与 Provider 实际 usage。 |
| 摘要延迟与成本 | 记录 P50/P95、摘要 Token、主请求 Token 节省量。 |
| 摘要失败与兜底率 | 可观测；突然升高时触发告警。 |

离线评估应比较：完整上下文基线、压缩上下文、连续多次压缩三组结果。只看 Token 节省量，无法证明模块质量。

## 4. 演进顺序

### P0：上线前必须补齐

- 建立 Context Eval：长对话关键事实、Tool 链、摘要失败和多次摘要。
- 校准 Token 估算误差，并为不同模型保留安全余量。
- 将大 Tool Result 改为摘要、预览和外部引用。
- 对摘要输入、摘要注入和 Trace 做敏感数据与 Prompt Injection 防护。

### P1：服务化时补齐

- 用稳定消息 ID 替换数组下标，持久化摘要、边界和版本。
- 同一 Session 串行执行；摘要写入使用版本校验和幂等重试。
- 为超时、限流、摘要失败和 Provider 超限定义明确降级路径。

### 暂不做

- 跨会话长期 Memory、自动 RAG 注入、多 Agent 共享上下文。
- 复杂相关度排序和多层优先级，等 Context Eval 证明简单策略不足后再引入。
