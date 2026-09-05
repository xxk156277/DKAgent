## Context

当前链路为 `查询 → BGE-M3 → pgvector 子块 Top-12 → 父文档聚合 Top-3 → 父文档上下文 → DeepSeek → 引用编号正则校验`。已有 20 条带 `expectedFacts` 的真实面经问题，但默认评估集事实为空，且没有生成质量报告。

## Goals / Non-Goals

**Goals:**

- 同一数据集可对照 Dense 与 Hybrid Recall@3。
- 完整问答评估可重复报告事实覆盖、引用支持、拒答、端到端延迟和调用量。
- 上下文裁剪永远优先保留命中子块，并减少父子切片 overlap 的重复浪费。
- 精确术语与语义召回经过 RRF 融合，最终仍返回不同父文档的 Top-3。

**Non-Goals:**

- 不接入 RAGAS、Phoenix、Elasticsearch、Reranker、查询重写或多模态。
- 不把模型裁判结果宣称为人工真值；评估报告必须保留逐题诊断信息。
- 不为超出当前语料规模设计分布式或持久化 BM25 索引。

## Decisions

### 1. 检索评估和完整问答评估分命令

`evaluate` 继续只调用 Embedding，并新增 `--strategy dense|hybrid`；`baseline` 才调用 DeepSeek 生成与验证。这样能频繁运行低成本检索回归，同时显式触发高成本完整基线。

20 条正例使用 `interview-questions.v1.jsonl`，拒答题单独存放并在 `baseline` 中合并。正例 Recall@3 不受负例影响；完整基线同时计算拒答准确率。

### 2. 命中块拥有上下文预算优先级

短父文档仍返回全文。长父文档先裁剪并保留命中块；剩余预算再分配给前后相邻块。相邻块拼接前计算“左侧后缀与右侧前缀的最长公共重叠”，删除重复区间。

当单个命中块大于预算时，只裁剪命中块本身；不会先填充邻居。字符预算仍为现有 6000，避免同时改变多个变量。

### 3. 引用验证采用语法门禁加模型语义裁判

先确定性检查答案至少包含一个有效 `[n]`，再把问题、草稿答案和实际编号证据交给同一 DeepSeek 模型，要求返回结构化结果：`citationSupported`、`unsupportedClaims` 和 `coveredFactIndexes`。

生产问答不传 `expectedFacts`，只判断引用是否支持答案；评估时 expected facts 仅提供给验证步骤，不进入答案生成提示，避免把标准答案泄漏给生成器。语义验证失败时返回拒答状态并保留草稿与原因用于诊断。

### 4. 小语料 BM25 在应用层实现

使用 Node 22 的 `Intl.Segmenter('zh-CN', { granularity: 'word' })` 进行中文和英文词元化，按标准 BM25 公式计算子块排名。每次进程内首次检索从 PostgreSQL 读取子块语料并建立内存索引；同一评估进程复用索引。

选择应用层实现是因为 PostgreSQL 内置 FTS 的中文切词和 `ts_rank` 不能等同于 BM25；为当前约 3747 个子块增加独立搜索服务成本过高。该选择的规模边界必须写入 README。

### 5. RRF 只融合排名，不混合原始分数

Dense 与 BM25 各取候选 Top-24，按 `1 / (60 + rank)` 相加得到子块 RRF 分数。这样无需把余弦相似度与 BM25 分数做不可解释的归一化。融合后按父文档去重，保留每篇父文档 RRF 最高的子块并取 Top-3。

结果保留 Dense 相似度、BM25 分数及两路 rank，供 CLI 和评估诊断。拒答阈值继续基于余弦相似度并必须重新校准；语义引用验证是最终证据门禁。

## Risks / Trade-offs

- [模型裁判也可能误判] → 报告标记为 model-judged，保留草稿、证据和逐题结果供人工抽查。
- [完整基线调用量增加] → 独立 `baseline` 命令并分别统计生成与验证 Token。
- [内存 BM25 首次构建有延迟] → 同一进程缓存；当前规模记录构建耗时，大规模迁移不在本 change。
- [RRF 提升精确词召回但可能扰动语义排序] → 保留 `--strategy dense` 并在相同黄金集上对照，不以单例成功判断提升。
- [已有工作区存在未提交教学和评估改动] → 仅在 rag-v2 范围增量修改，不覆盖或回滚这些文件。

## Migration Plan

1. 先保存现有 Dense Recall@3 基线。
2. 先写 BM25、RRF、上下文和引用验证失败测试，再实现最小代码。
3. 增加完整基线报告与 CLI，运行 Dense/Hybrid 对照。
4. 运行 rag-v2 单元测试、可用时运行 pgvector 集成测试、类型检查、diff check 和 OpenSpec strict validate。

数据库 schema 不变；回退只需恢复检索、上下文、问答与评估代码，不需要迁移数据。
