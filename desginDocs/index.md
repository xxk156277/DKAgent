# DKAgent 面试分析设计

本目录沉淀DKAgent面试文字稿分析的产品与系统设计。当前范围只包括用户已经转换好的长文字稿，不包含音频和语音转写。

## 文档导航

| 文档 | 内容 |
|---|---|
| [01-prd.md](./01-prd.md) | 产品目标、范围、评分、报告和验收标准 |
| [02-sop-agent-nodes.md](./02-sop-agent-nodes.md) | Agent、Skill、Tool、LLM边界及完整SOP |
| [03-business-flow.drawio](./03-business-flow.drawio) | 用户两阶段面试分析业务流程 |
| [04-system-architecture.drawio](./04-system-architecture.drawio) | 基于DKAgent现状的最小增量架构 |

## 已确认的核心决策

- 使用固定SOP＋关键节点语义判断，不采用自由Agent全程规划。
- Agent控制用户对话，`analyze_interview` 业务Tool启动 `diagnose-transcript` Skill控制完整分析流程。
- Agent公共注册表仅暴露基础文件Tool和一个面试业务Tool；内部原子分析能力不对Agent公开。
- 报告分为面试分析总览与完整问题列表两部分，当前只生成 `provisional` 暂定报告。
- 总分采用固定五维权重，只评价可观察表现，不预测面试结果。
- JD岗位匹配独立于通用评分，必须引用JD原文和已有问题证据。

## 实现状态边界

当前已经接入可运行的暂定分析闭环：Agent按目录/关键词查找并确认文字稿，调用唯一的 `analyze_interview`，Skill完成长稿分页读取、结构化、分题型分析和不覆盖的 Markdown 报告写入。可选JD可生成不影响通用分数的岗位匹配。

本目录仍保留目标设计内容，其中“初步分析后集中确认、局部重跑、final报告、Session暂停恢复和表现Memory时间线”尚未实现；音频/语音转写和文件上传也不在当前范围。以 [02-sop-agent-nodes.md](./02-sop-agent-nodes.md) 的当前边界为准。
