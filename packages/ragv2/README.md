# 大康 Note 父子 RAG

一个用于学习和诊断 RAG 的 TypeScript 项目：文件作为父文档，H1/H2/H3 标题块作为检索子块，向量存入 PostgreSQL + pgvector。

## 1. 配置

在仓库根目录 `.env` 增加：

```dotenv
SILICONFLOW_API_KEY=你的密钥
DATABASE_URL=postgresql://rag:rag@localhost:5439/rag
```

已有的 `DEEPSEEK_API_KEY` 用于 `ask`。变量全集见 `.env.example`。不要把大康 Note 或密钥复制进项目。

## 2. 启动与索引

```bash
cd packages/rag
docker compose up -d
pnpm db:migrate
pnpm ingest
pnpm rag search "SSE 和普通 HTTP 有什么区别"
```

重复执行 `pnpm ingest` 时，内容哈希未变化的文件不会重新生成 Embedding。

## 3. 诊断与评估

```bash
pnpm stats
pnpm rag inspect --document "C-前端学习/node/SSE.md"
pnpm rag evaluate
pnpm rag ask "为什么 Agent 需要上下文压缩？"
```

`eval/questions.jsonl` 是 20 题种子集。先人工补齐并核对 `expectedFacts`，再把 Recall@3 当作有效基线。报告逐题展示预期事实、是否应拒答、返回路径、分数、延迟，并汇总 Embedding tokens；引用是否支持答案、回答完整性和拒答正确性仍由你手工判定。若正例与拒答题的 Top-1 分数区间不重叠，报告会给出建议阈值；否则不要依赖单一相似度阈值。

## 当前边界

- 图片只保存引用与邻近文字，`needsVision=true` 不代表已完成多模态。
- 当前只有 Dense 检索；BM25、RRF、查询重写和重排应由真实失败案例驱动。
- 云端 Embedding 白名单不包含 `Z-前东家/Tower`、个人、面试和股票目录。
