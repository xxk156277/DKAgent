# Context 图集重新生成设计

## 目标

将原来的单文件图集改为 4 个独立 Draw.io 文件。每个文件打开后直接显示一张图，内容与当前 DKAgent 源码保持一致。

## 文件与内容

| 文件                                       | 核心内容                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `01-context-architecture.drawio`         | AgentLoop、Memory Recall、ContextManager、QueryEngine、Provider 及支撑组件的职责边界。 |
| `02-context-data-flow.drawio`            | 用户输入、完整历史、召回记忆、摘要状态、Token 预算到 ContextSnapshot 的数据流。                     |
| `03-context-compaction-flow.drawio`      | 80% 触发、60% 目标、Tool 消息分组、增量摘要和删除兜底。                                      |
| `04-context-production-evolution.drawio` | 当前能力、生产问题、P0/P1 解决方案的对应关系。                                              |

## 绘制约束

- 中文标注；每张图只表达一个主题。
- 当前事实与生产建议使用不同颜色和分区，避免混淆“已实现”和“待演进”。
- 架构图包含当前已经接入的 Memory Recall，但不把 Memory 内部实现展开到 Context 图中。
- 使用标准 Draw.io XML；4 个文件必须能够分别通过 XML 格式校验。

## 验收标准

- 4 个独立文件均存在并可单独打开。
- 节点、箭头和说明与当前 Context、AgentLoop 源码一致。
- 不再依赖原来的多页文件切换。
