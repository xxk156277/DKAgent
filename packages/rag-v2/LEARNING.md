# 四天吃透路线

目标不是背 API，而是能沿着 `数据 → Chunk → Embedding → TopK → Context → Answer` 定位问题。

## 第 1 天：父子切块

阅读顺序：`src/domain/types.ts` → `src/ingestion/parser.ts` → `src/ingestion/scanner.ts`。

```bash
pnpm test
pnpm rag inspect --document "C-前端学习/node/SSE.md"
```

需要能回答：为什么用小块检索、大块生成？标题路径为什么要进入 Embedding 文本？同名标题为什么需要 ordinal？图片块为什么只标记而不假装已经理解？

练习：修改一个测试文档的标题或正文，观察 `parentId/chunkId/contentHash` 哪些变化。

## 第 2 天：pgvector 检索

阅读顺序：`src/embedding/embedding.ts` → `src/storage/database.ts` → `src/ingestion/ingest.ts` → `src/retrieval/search.ts`。

数据库基础先阅读 [`GATE_2_DATABASE.md`](GATE_2_DATABASE.md)，完成其中的只读查询和事务回滚实验。

向量检索与父文档聚合阅读 [`GATE_3_RETRIEVAL.md`](GATE_3_RETRIEVAL.md)，完成 Top-12 → Top-3 的预测和真实搜索检查。

```bash
docker compose up -d
pnpm db:migrate
pnpm ingest
pnpm rag search "SSE 的响应头有哪些" --top-k 3
pnpm stats
```

需要能回答：`vector(1024)` 的 1024 来自哪里？cosine distance 与 similarity 如何换算？HNSW 为什么是近似检索？为什么先取 12 个子块再聚合 3 个父文档？

练习：连续执行两次 `ingest`，确认第二次 `chunksEmbedded=0`。

## 第 3 天：Recall@3 与真实问题

先人工核对 `eval/questions.jsonl` 的相关文档和 `expectedFacts`，再运行：

完整教学见 [`GATE_4_EVALUATION.md`](GATE_4_EVALUATION.md)。本关不再做预测题，以真实评估报告作为验收结果。

```bash
# 中文注释：运行20题检索评估，不调用DeepSeek
pnpm rag evaluate
```

对每个失败只归入一个首要原因：数据缺失、标题切块、查询与术语不一致、父文档聚合、图片缺失。优先修分块和元数据；当前阶段不直接添加 BM25、RRF 或重排。

需要能回答：Recall@3 的分母是什么？为什么 20 题只能用于开发闭环，不能证明 80% 线上有效率？相似度阈值为什么不能照抄？

## 第 4 天：生成、引用与拒答

阅读顺序：`src/generation/context.ts` → `src/generation/ask.ts`。

完整教学见 [`GATE_5_GENERATION.md`](GATE_5_GENERATION.md)。本关以可回答问题和拒答问题的真实输出作为验收依据。

```bash
# 中文注释：执行完整RAG问答，会调用查询Embedding和DeepSeek
pnpm rag ask "Agent 为什么需要上下文压缩？"
```

检查回答中的每个 `[n]` 是否真正支持前面的结论。短父文档返回全文，长父文档返回命中块及相邻块；总上下文受 6000 字符预算约束。

需要能回答：检索命中不等于回答正确；Prompt 拒答、相似度拒答和证据支持检查分别解决什么问题；什么时候图片文件名和邻近文字不够，必须加入视觉描述或多模态 Embedding？
