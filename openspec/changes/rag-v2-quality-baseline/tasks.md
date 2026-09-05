## 1. 评估基线

- [x] 1.1 保存实现前 Dense 20 题 Recall@3、延迟和 Embedding 用量
- [x] 1.2 先写失败测试，再增加独立拒答集、完整问答评估类型和汇总指标
- [x] 1.3 增加显式 `baseline` CLI，输出逐题状态、事实覆盖、引用支持、拒答、延迟和调用量

## 2. 可靠上下文

- [x] 2.1 先写失败测试，覆盖前一块超长时命中块仍被保留
- [x] 2.2 实现命中块优先、邻居剩余预算和相邻 overlap 去重
- [x] 2.3 覆盖短父文档全文、缺失 chunkId 和总预算边界回归

## 3. 语义级引用检查

- [x] 3.1 先写失败测试，覆盖合法编号但证据不支持、事实覆盖和结构化结果校验
- [x] 3.2 实现 DeepSeek 结构化语义验证，expectedFacts 只进入验证步骤
- [x] 3.3 无支持时降级拒答，并分别记录生成/验证 Token 与可诊断原因

## 4. BM25 + Dense + RRF

- [x] 4.1 先写失败测试，覆盖中文/英文词元、BM25 精确词排序与 RRF 双路融合
- [x] 4.2 增加子块词法语料读取和进程内 BM25 索引
- [x] 4.3 实现 Dense/BM25 Top-24、RRF(k=60) 和父文档 Top-3 聚合
- [x] 4.4 CLI 支持 `--strategy dense|hybrid` 并显示两路排名和融合分数

## 5. 验收

- [x] 5.1 通过 rag-v2 单元测试和 TypeScript strict typecheck
- [x] 5.2 在可用 PostgreSQL 上通过迁移、Dense、Hybrid 和父文档聚合集成验证
- [x] 5.3 运行 Dense/Hybrid 同集对照，记录 Recall@3、延迟和用量
- [ ] 5.4 运行完整基线；若真实模型不可用，明确标记 needs_verification，不伪造指标
- [x] 5.5 通过 `git diff --check` 与 `openspec validate rag-v2-quality-baseline --strict`
