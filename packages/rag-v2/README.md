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
│   └── search.ts                # 问题向量化、子块召回和父文档聚合
├── generation/
│   ├── context.ts               # 从父文档选择命中块及相邻块，拼装证据上下文
│   └── ask.ts                   # 调用 DeepSeek，执行拒答、生成和引用检查
├── evaluation/
│   └── evaluate.ts              # 执行 20 题 Recall@3、延迟和阈值评估
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
- `retrieval` 只负责找到证据，不负责组织最终答案。
- `generation` 使用检索证据回答，并处理上下文、引用和拒答。
- `evaluation` 复用真实检索链路，衡量召回效果，不参与线上问答。

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
pnpm stats
pnpm rag inspect --document "C-前端学习/node/SSE.md"
pnpm rag evaluate
pnpm rag ask "为什么 Agent 需要上下文压缩？"
```

`eval/questions.jsonl` 是 20 题种子集。先人工补齐并核对 `expectedFacts`，再把 Recall@3 当作有效基线。报告逐题展示预期事实、是否应拒答、返回路径、分数、延迟，并汇总 Embedding tokens；引用是否支持答案、回答完整性和拒答正确性仍由你手工判定。若正例与拒答题的 Top-1 分数区间不重叠，报告会给出建议阈值；否则不要依赖单一相似度阈值。

## 学习关卡

- [`GATE_1.md`](GATE_1.md)：Markdown 父文档与标题子块。
- [`GATE_2_DATABASE.md`](GATE_2_DATABASE.md)：PostgreSQL、pgvector 与事务入库。
- [`GATE_3_RETRIEVAL.md`](GATE_3_RETRIEVAL.md)：查询向量、余弦检索与父文档聚合。

## 当前边界

- 图片只保存引用与邻近文字，`needsVision=true` 不代表已完成多模态。
- 当前只有 Dense 检索；BM25、RRF、查询重写和重排应由真实失败案例驱动。
- 云端 Embedding 白名单不包含 `Z-前东家/Tower`、个人、面试和股票目录。
