## Purpose

为小规模纯文字 Markdown RAG 提供可对照的检索基线、可靠证据上下文、语义引用门禁和混合召回。

## ADDED Requirements

### Requirement: Evaluation separates retrieval and answer quality

系统 SHALL 支持不调用生成模型的 Dense/Hybrid 检索评估，以及显式触发的完整问答基线；完整基线 SHALL 报告 Recall@3、expected facts 覆盖、引用支持、拒答、端到端延迟和生成/验证调用量。

#### Scenario: Run retrieval regression without generation cost
- **WHEN** 用户运行检索评估并选择 Dense 或 Hybrid
- **THEN** 系统只调用查询 Embedding 和检索，并输出该策略的 Recall@3、延迟及 Embedding 用量

#### Scenario: Run complete answer baseline
- **WHEN** 用户显式运行完整基线
- **THEN** 系统对正例与拒答例生成逐题结果，并汇总事实覆盖、引用支持、拒答准确率、延迟和各阶段 Token

#### Scenario: Expected facts do not leak into generation
- **WHEN** 完整基线包含 expectedFacts
- **THEN** expectedFacts 只发送给答案验证步骤，不得出现在答案生成提示中

### Requirement: Hit chunk is preserved before neighbors

系统 SHALL 在长父文档中优先保留命中子块，再使用剩余字符预算加入相邻子块；拼接相邻子块时 SHALL 删除切片边界的重复文本。

#### Scenario: Previous chunk exceeds source budget
- **WHEN** 前一子块本身足以占满来源预算
- **THEN** 返回上下文仍从命中子块取得内容，不得因先拼前块而丢失命中证据

#### Scenario: Adjacent chunks share overlap
- **WHEN** 相邻子块的后缀和前缀包含相同切片 overlap
- **THEN** 组装上下文只保留一份重复文本，并保持总长度不超过预算

#### Scenario: Parent document fits budget
- **WHEN** 父文档全文长度不超过来源预算
- **THEN** 系统返回完整父文档而不是重组子块

### Requirement: Citation validity includes semantic support

系统 SHALL 先验证答案引用编号存在且落在实际来源范围内，再使用结构化模型输出判断关键结论是否被其引用证据支持；任一步失败 SHALL 返回可诊断拒答。

#### Scenario: Citation number is valid but evidence is unrelated
- **WHEN** 草稿答案包含合法 `[1]`，但来源 1 不支持对应关键结论
- **THEN** 系统拒绝返回该草稿，并记录 unsupported claim 与语义验证调用量

#### Scenario: Citation evidence supports answer
- **WHEN** 所有关键结论均由对应编号证据支持
- **THEN** 系统返回草稿答案和结构化 citationSupported 结果

#### Scenario: Semantic verifier output is invalid
- **WHEN** 验证模型未返回满足 Schema 的结构化结果
- **THEN** 系统按验证失败拒答，不把未验证草稿当成可靠答案

### Requirement: Hybrid retrieval fuses BM25 and Dense ranks

系统 SHALL 使用同一子块语料分别生成 BM25 与 Dense 候选，通过 RRF(k=60) 融合子块排名，再按父文档聚合 Top-K；系统 SHALL 保留 Dense 模式用于同集对照。

#### Scenario: Exact term is weak in Dense retrieval
- **WHEN** 查询包含正文中精确出现的专有词或错误码，但该子块未进入 Dense 前列
- **THEN** BM25 排名可让该子块通过 RRF 进入融合候选

#### Scenario: Same chunk appears in both retrievers
- **WHEN** 同一子块同时进入 Dense 和 BM25 候选
- **THEN** 其 RRF 分数累加两路排名贡献，不比较或相加余弦与 BM25 原始分数

#### Scenario: Multiple chunks belong to one parent
- **WHEN** 融合前列包含同一父文档的多个子块
- **THEN** 最终 Top-K 每篇父文档只保留 RRF 分数最高的子块
