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
- Agent控制用户对话，`diagnose-transcript` Skill控制完整分析流程。
- V1保留8个粗粒度业务Tool，不新增Workflow Engine和多Agent。
- 报告分为面试分析与完整问题列表两部分。
- 总分采用固定五维权重，只评价可观察表现，不预测面试结果。
- 初步分析后集中确认3～5个关键事实，最终报告成功后才写入表现时间线。

## 实现状态边界

这些文件是经过确认的目标设计，不代表当前DKAgent已经实现完整面试分析。当前主链已具备AgentLoop、Tool Calling、Context、Session和Memory等基础能力；诊断Skill、长稿结构化、分题型分析和最终报告仍属于待实现范围。
