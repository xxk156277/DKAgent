## Why

RAG v2 已具备 Markdown 父子切块、pgvector Dense 检索和带编号回答，但当前评估只覆盖父文档召回；长父文档上下文可能先截断命中块；引用检查只验证编号范围；专有名词、错误码和精确术语只能依赖向量召回。需要在不引入重型平台的前提下，为当前约 300～400 篇 Markdown 建立可重复的质量基线并补齐关键可靠性能力。

## What Changes

- 建立 20 条可回答黄金问题和独立拒答问题的完整基线，分别报告检索 Recall@3、回答完整性、引用支持、拒答、延迟和模型用量。
- 长父文档上下文改为优先保留命中块，再使用剩余预算加入前后块，并消除相邻切片的重复区间。
- 在引用编号校验后增加结构化语义支持检查；无证据支持的草稿答案降级拒答，并保留可诊断原因。
- 使用 Node 内置中文分词实现当前语料规模的 BM25，与 pgvector Dense 候选通过 RRF 融合，再按父文档聚合 Top-3。
- CLI 支持 Dense/Hybrid 对照，完整问答评估使用独立命令，避免普通检索评估产生 DeepSeek 费用。

## Capabilities

### New Capabilities

- `rag-quality-baseline`: 定义完整评估、可靠上下文、语义引用验证与混合检索的可验证行为。

### Modified Capabilities

- 无。当前仓库尚未为 rag-v2 建立基线 capability spec。

## Impact

- 影响 `packages/rag-v2/src/{retrieval,generation,evaluation,storage}`、CLI、领域类型、评估数据与测试。
- 每次成功生成答案增加一次 DeepSeek 验证调用，必须单独统计其 Token 与延迟。
- BM25 首次检索需要读取并分词全部子块；当前快照约 3747 子块可接受，但不是大规模语料方案。
- 不改变 Markdown 切块、Embedding 模型、pgvector 表中向量维度或摄入事务。
