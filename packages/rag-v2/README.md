# 大康 Note 父子 RAG

一个用于学习和诊断 RAG 的 TypeScript 项目：文件作为父文档，H1/H2/H3 标题块作为检索子块，向量存入 PostgreSQL + pgvector。

## 目录结构

```text
src/
├── cli.ts                       # CLI 入口：根据命令装配并调用各模块
├── config.ts                    # 从仓库根 .env 读取并校验运行配置
├── domain/
│   └── types.ts                 # 父文档、子块、命中结果等公共类型
├── ingestion/
│   ├── ingest.ts                # 摄入总流程：扫描、增量判断、向量化、写库和删除同步
│   ├── scanner.ts               # 按白名单查找并读取 Markdown 文件
│   └── parser.ts                # Markdown AST 解析、标题切块、图片标记和稳定 ID
├── embedding/
│   └── embedding.ts             # 调用 BGE-M3，将文本转换为 1024 维向量
├── storage/
│   └── database.ts              # PostgreSQL/pgvector 迁移、事务写入与向量查询
├── retrieval/
│   ├── bm25.ts                  # 中文/英文词元化与内存 BM25
│   └── search.ts                # Dense/BM25候选、RRF和父文档聚合
├── generation/
│   ├── context.ts               # 从父文档选择命中块及相邻块，拼装证据上下文
│   ├── citation.ts              # DeepSeek结构化语义引用与事实覆盖检查
│   └── ask.ts                   # 执行检索、拒答、生成和引用门禁
├── evaluation/
│   └── evaluate.ts              # 检索对照与完整问答基线
└── shared/
    ├── hash.ts                  # SHA-256 内容哈希与稳定 ID 基础能力
    └── errors.ts                # CLI 错误格式化及敏感信息保护
```

### 模块之间如何协作

```text
离线建索引：
cli
└─ ingestion
   ├─ scanner → parser → domain types
   ├─ embedding
   └─ storage

在线查询：
cli
└─ generation/ask
   ├─ retrieval/search
   │  ├─ embedding
   │  └─ storage
   └─ generation/context → storage

离线评估：
cli
└─ evaluation
   └─ retrieval/search
```

- `domain` 不执行业务，只定义各模块共同使用的数据结构。
- `ingestion` 负责把外部 Markdown 变成可检索数据，不负责回答问题。
- `embedding` 只负责文本与向量的转换，不关心数据存在哪里。
- `storage` 封装 PostgreSQL 和 pgvector，其他模块不直接书写 SQL。
- `retrieval` 用 Dense 和 BM25 找候选，再由 RRF 融合，不负责组织最终答案。
- `generation` 优先保留命中块，使用检索证据回答，并处理引用语义检查和拒答。
- `evaluation` 既能运行低成本检索回归，也能显式运行完整问答基线。

## 1. 配置

在仓库根目录 `.env` 增加：

```dotenv
SILICONFLOW_API_KEY=你的密钥
DATABASE_URL=postgresql://rag:rag@localhost:5439/rag
```

已有的 `DEEPSEEK_API_KEY` 用于 `ask`。变量全集见 `.env.example`。不要把大康 Note 或密钥复制进项目。

## 2. 启动与索引

```bash
cd packages/rag-v2
docker compose up -d
pnpm db:migrate
pnpm ingest
pnpm rag search "SSE 和普通 HTTP 有什么区别"
```

重复执行 `pnpm ingest` 时，内容哈希未变化的文件不会重新生成 Embedding。

## 3. 诊断与评估

```bash
# 中文注释：查看数据库统计
pnpm stats

# 中文注释：检查指定父文档
pnpm rag inspect --document "C-前端学习/node/SSE.md"

# 中文注释：运行 Dense 对照，只调用查询 Embedding
pnpm rag evaluate --strategy dense

# 中文注释：运行 BM25 + Dense + RRF 检索评估
pnpm rag evaluate --strategy hybrid

# 中文注释：运行22题完整基线，会调用DeepSeek生成与语义验证
pnpm rag baseline

# 中文注释：从仓库根运行 Promptfoo 四项语义评估和拒答检查
pnpm eval:rag

# 中文注释：执行一次完整问答
pnpm rag ask "为什么 Agent 需要上下文压缩？"
```

`eval/interview-questions.v1.jsonl` 是 20 条可回答黄金问题，`eval/refusal-questions.v1.jsonl` 是独立负例。`evaluate` 只测 Recall@3；`baseline` 额外报告模型裁判的事实覆盖、引用支持、拒答、端到端延迟和生成/验证 Token。模型裁判不是人工真值，仍需抽查逐题草稿、证据和 unsupported claims。

Promptfoo 接入位于仓库根目录 `evals/rag-v2`：正例额外报告 Context Recall、Context Relevance（Context Precision 代理）、Answer Relevancy 和 Faithfulness；拒答例检查 `is-refusal`。Promptfoo 不替代确定性的 Recall@3，首次基线也不预设评分门槛。

当前同一快照结果见 [`eval/baselines/dense-before-hybrid.md`](eval/baselines/dense-before-hybrid.md) 和 [`eval/baselines/hybrid-v1.md`](eval/baselines/hybrid-v1.md)。

## 4. 接入 DKAgent

在仓库根目录 `.env` 显式开启只读知识库 Tool：

```dotenv
# 中文注释：开启后，Agent 才会看到 query_knowledge_base Tool
RAG_ENABLED=true
```

然后从仓库根目录启动 Agent：

```bash
# 中文注释：启动 DKAgent，Agent 会按需决定是否检索知识库
pnpm --filter @dkagent/agent run agent
```

这条链路是 `Agent → query_knowledge_base → Hybrid 检索 → Top-3 父文档证据 → Agent 当前模型回答`。Tool 本身不调用 DeepSeek 生成或语义裁判，因此不会形成两次回答；引用仍应使用 Tool 返回的 `[n] 路径#标题`。

## 学习关卡

- [`GATE_1.md`](GATE_1.md)：Markdown 父文档与标题子块。
- [`GATE_2_DATABASE.md`](GATE_2_DATABASE.md)：PostgreSQL、pgvector 与事务入库。
- [`GATE_3_RETRIEVAL.md`](GATE_3_RETRIEVAL.md)：查询向量、余弦检索与父文档聚合。
- [`GATE_4_EVALUATION.md`](GATE_4_EVALUATION.md)：20题Recall@3、延迟、成本与失败归因。
- [`GATE_5_GENERATION.md`](GATE_5_GENERATION.md)：证据上下文、DeepSeek生成、引用与拒答。

## 当前边界

- 图片只保存引用与邻近文字，`needsVision=true` 不代表已完成多模态。
- 当前 BM25 在应用进程内读取并缓存全部子块，适合约 3747 子块的本地项目；更大语料需要重新评估持久化词法索引或专用搜索服务。
- 当前没有查询重写和重排；是否增加仍应由失败案例驱动。
- 每个成功草稿会增加一次 DeepSeek 语义验证调用，延迟和 Token 已分阶段统计。
- 云端 Embedding 白名单不包含 `Z-前东家/Tower`、个人、面试和股票目录。
