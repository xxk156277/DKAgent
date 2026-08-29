# RAG 检索 Golden Dataset 设计

## 目标

为 `packages/rag-v2` 建立一份独立的 10 条离线检索测试集，作为首个可人工核验的基线。测试集只依据大康 Note 中真实存在的 Markdown 原文生成，不复用现有 `eval/questions.jsonl` 的题目文本，也不以当前 Retriever 的返回结果反推标准答案。

## 输出

新增 `packages/rag-v2/eval/questions.v1.jsonl`，沿用当前评估器已经支持的格式：

```ts
interface EvaluationQuestion {
    query: string;
    relevantSourcePaths: string[];
    expectedFacts: string[];
    shouldRefuse: boolean;
}
```

不修改现有 `eval/questions.jsonl`、领域类型、JSONL 解析器或检索实现。

## 样本组成

- 8 条可回答问题：覆盖关键词检索、语义改写、多事实或多来源问题，以及相似主题干扰。
- 2 条不可回答问题：问题应落在知识库没有可靠证据支持的范围，用于检查拒答边界。
- 每个可回答问题至少包含一条由原文直接支持的 `expectedFacts`。
- `relevantSourcePaths` 使用 Vault 根目录下的真实相对路径；多文档问题列出回答所需的全部来源。
- 不可回答问题使用空 `relevantSourcePaths` 和空 `expectedFacts`，并设置 `shouldRefuse: true`。

## 数据生成流程

1. 从当前扫描白名单覆盖的 Markdown 中选择候选原文。
2. 阅读原文并提取可独立核验的事实。
3. 基于事实重新设计自然语言问题，避免复制文档标题形成过于简单的关键词命中。
4. 写入 JSONL 后检查每行 JSON、Schema 和来源路径。
5. 使用现有评估读取逻辑验证 10 条数据能够被正确加载。
6. 数据库、索引与 Embedding 服务可用时，再运行真实 Recall@3；本次不把外部服务结果作为创建数据集的必要条件。

## 验收标准

- 新文件恰好包含 10 条有效 JSONL 记录。
- 8 条 `shouldRefuse: false`，2 条 `shouldRefuse: true`。
- 8 条正例的所有来源文件当前均存在，且事实可在对应原文中找到。
- 不含空白正例事实，不复用旧测试集的题目文本。
- 现有测试、类型检查和新的数据集校验均通过；若存在与本次无关的既有失败，单独报告而不修改。

## 非目标

- 不实现 Hit@5、Recall@5、MRR 或 Faithfulness 的新计算逻辑。
- 不调整 Chunk、Embedding、TopK、Reranker 或 Prompt。
- 不批量扩充为生产级评估集，也不把 10 条样本描述成完整质量证明。
