## Why

`rag-v2` 已能对大康 Note 做混合检索和可靠上下文组装，但当前只能通过独立 CLI 使用。DKAgent 的 `ToolRegistry` 尚未注册知识库能力，因此 Agent 无法按问题主动检索这些私有证据。

## What Changes

- 为 `rag-v2` 增加可被工作区其他包调用的只读检索服务入口。
- 在 Agent 中增加 `query_knowledge_base` Tool，返回 Top-3 编号证据与检索诊断信息。
- 仅在 `RAG_ENABLED=true` 时注册 Tool；未启用时保持现有 Agent 行为。
- 复用 Agent 当前模型组织最终回答，不在 Tool 内再次调用生成模型。

## Capabilities

### New Capabilities

- `rag-agent-tool`: 定义 DKAgent 可选调用 RAG v2 检索并消费可追溯证据的行为。

### Modified Capabilities

- 无。

## Impact

- 影响 `packages/rag-v2` 的公共导出、`packages/agent` 的配置、Tool 注册和 CLI 装配。
- Agent 启用 RAG 后，每次 Tool 调用会产生一次 Embedding 请求和 PostgreSQL 查询。
- 不改变现有索引、数据库 schema、AgentLoop 或 RAG 生成与引用裁判流程。
