## Context

DKAgent 当前通过 `createToolRegistry` 暴露能力，Tool 结果会序列化回模型上下文。`rag-v2` 的 `searchKnowledge` 和 `buildEvidenceBundle` 已分别提供混合检索与可靠上下文，但配置和对象装配仍只存在于 CLI。

## Goals / Non-Goals

**Goals:**

- Agent 可按需调用知识库并得到可直接用于回答的编号证据。
- RAG 未启用时不连接数据库、不要求 Embedding Key，也不新增 Tool schema。
- Tool 的检索依赖可注入，使单元测试不访问真实模型和数据库。
- CLI 退出时关闭 RAG 数据库连接池。

**Non-Goals:**

- 不做自动路由、查询重写、重排、多模态理解或权限分级。
- 不在 Tool 内生成最终答案或执行语义引用裁判。
- 不替换 `packages/agent/src/knowledge` 的旧实验代码。

## Decisions

### 1. 使用可选只读 Tool，而非自动注入

新增 `query_knowledge_base`，由 Agent 根据 Tool 描述决定是否调用。这样普通对话没有固定检索成本，也不会把私有知识无条件塞入每轮上下文。

### 2. rag-v2 暴露应用服务而非底层拼装细节

公共服务持有 `RagDatabase` 与 `EmbeddingService`，对外只暴露 `query(query, topK)` 和 `close()`。查询固定使用 Hybrid，并复用 `buildEvidenceBundle` 生成总计不超过 6000 字符的证据。

### 3. Agent 依赖最小 Retriever 端口

Tool 只依赖 `KnowledgeRetriever` 接口。生产环境传入 rag-v2 服务；测试传入 Fake Retriever。Tool 输入限制为非空 `query` 和 1～5 的 `topK`，默认 3。

### 4. 显式开关控制接入

仅 `RAG_ENABLED=true` 时，Agent 配置才要求 `SILICONFLOW_API_KEY`，并使用 `DATABASE_URL`、Embedding Base URL 与模型名创建服务。未启用时不会注册 Tool。

## Risks / Trade-offs

- [模型可能不调用 Tool] → Tool 描述明确用于私有笔记事实；端到端测试覆盖 schema 暴露和 Tool 结果回传，不把模型选择稳定性伪装为确定性。
- [证据正文增加上下文体积] → 复用 rag-v2 的 6000 字符总预算，并继续受 Agent ContextManager 管理。
- [应用层 BM25 首次查询较慢] → 复用现有进程缓存；当前约 300～400 篇文档规模可接受。

## Migration Plan

1. 增加失败测试，覆盖可选注册、输入校验和证据返回。
2. 增加 rag-v2 公共服务与 Agent Tool。
3. 将可选服务装配到 CLI，并在 finally 关闭连接。
4. 运行聚焦测试、两个包的类型检查、diff check 和 OpenSpec strict validate。
