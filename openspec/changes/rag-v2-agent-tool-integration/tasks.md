## 1. 契约与公共服务

- [x] 1.1 先写失败测试，覆盖 Tool 输入、结果和可选注册
- [x] 1.2 为 rag-v2 增加只读查询服务与公共导出

## 2. Agent 接入

- [x] 2.1 增加 RAG 可选配置与启用时的必填校验
- [x] 2.2 实现 `query_knowledge_base` 并注册到 ToolRegistry
- [x] 2.3 CLI 装配 rag-v2 服务并在退出时关闭连接池

## 3. 验收

- [x] 3.1 通过 Agent RAG Tool 聚焦测试
- [x] 3.2 通过 agent 与 rag-v2 TypeScript strict typecheck
- [x] 3.3 通过 `git diff --check` 与 OpenSpec strict validate
