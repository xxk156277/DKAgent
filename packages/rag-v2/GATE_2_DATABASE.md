# 第二关数据库入门：只学 RAG 项目真正用到的 PostgreSQL

> 目标：能够看懂 `storage/database.ts`，知道父子文档和向量如何安全地写入 PostgreSQL。  
> 本教程不要求系统学习数据库理论，不进入复杂 SQL、查询优化、备份和集群运维。

## 1. 学完后需要会什么

你应该能用自己的话解释：

1. Docker、PostgreSQL、pgvector 和 Node.js 分别负责什么；
2. `rag_documents` 与 `rag_chunks` 为什么是一对多关系；
3. 主键、外键、唯一约束和级联删除解决什么问题；
4. 为什么更新一篇文档必须使用事务；
5. `vector(1024)`、余弦距离和 HNSW 索引分别是什么。

完整位置：[`src/storage/database.ts`](src/storage/database.ts)

---

## 2. 先建立运行地图

```mermaid
flowchart LR
    A["TypeScript RAG"] -->|"pg 参数化 SQL"| B["localhost:5439"]
    B --> C["Docker 端口映射"]
    C --> D["PostgreSQL 容器:5432"]
    D --> E["rag 数据库"]
    E --> F["rag_documents"]
    E --> G["rag_chunks"]
    D --> H["pgvector 扩展"]
    H --> G
```

各部分职责：

| 部分 | 职责 |
|---|---|
| Docker | 在本机运行并持久化 PostgreSQL |
| PostgreSQL | 保存父文档、子块和它们的关系 |
| pgvector | 让 PostgreSQL 能保存向量并计算相似度 |
| `pg` | TypeScript 连接 PostgreSQL 的驱动 |
| `RagDatabase` | 封装项目需要的 SQL，不让其他模块直接操作数据库 |

当前 [`docker-compose.yml`](docker-compose.yml) 的端口：

```text
Mac localhost:5439 → PostgreSQL 容器:5432
```

连接串：

```text
postgresql://rag:rag@localhost:5439/rag
             │   │       │       └─ 数据库名
             │   │       └─ 主机和端口
             │   └─ 密码
             └─ 用户名
```

---

## 3. 连接数据库，只做观察

在 DKAgent 根目录执行：

```bash
docker compose -f packages/rag-v2/docker-compose.yml exec postgres psql -U rag -d rag
```

进入 `psql` 后，提示符类似：

```text
rag=#
```

先学习这些命令：

```sql
\dt
```

查看所有表。

```sql
\d rag_documents
\d rag_chunks
```

查看表字段、约束和索引。

```sql
SELECT extname, extversion
FROM pg_extension
WHERE extname = 'vector';
```

确认 pgvector 扩展已经安装。

退出：

```sql
\q
```

`\dt`、`\d`、`\q` 是 `psql` 客户端命令，不是标准 SQL。

---

## 4. 两张表就是父子模型

```mermaid
erDiagram
    RAG_DOCUMENTS ||--o{ RAG_CHUNKS : contains

    RAG_DOCUMENTS {
        text id PK
        text source_path UK
        text title
        text content
        text content_hash
        jsonb frontmatter
        timestamptz modified_at
        timestamptz indexed_at
    }

    RAG_CHUNKS {
        text id PK
        text parent_id FK
        integer sequence
        text_array heading_path
        text content
        jsonb image_refs
        boolean needs_vision
        vector_1024 embedding
    }
```

关系是：

```text
一篇 rag_documents 父文档
    ↓ parent_id
可以对应多条 rag_chunks 子块
```

例如：

```text
rag_documents
└─ C-前端学习/node/SSE.md
   ├─ chunk 0：SSE 是什么
   ├─ chunk 1：SSE 适合什么场景
   ├─ chunk 2：SSE 和普通 HTTP 的区别
   └─ chunk 3：SSE 的响应头
```

### 为什么不把所有内容放在一张表

因为父文档和子块职责不同：

- 父文档保存完整来源、原文和增量 Hash；
- 子块保存局部内容及其 Embedding；
- 一篇文件可以有多个子块；
- 搜索子块后，还需要通过 `parent_id` 找回完整父文档。

---

## 5. 先掌握四种约束

### 5.1 主键 `PRIMARY KEY`

```sql
id text PRIMARY KEY
```

作用：唯一标识一条记录，不能重复，也不能为空。

项目中：

```text
rag_documents.id = parentId
rag_chunks.id    = chunkId
```

### 5.2 唯一约束 `UNIQUE`

```sql
source_path text UNIQUE NOT NULL
```

作用：同一个 Markdown 路径只能有一条父文档记录。

### 5.3 外键 `FOREIGN KEY`

```sql
parent_id text NOT NULL
  REFERENCES rag_documents(id)
```

作用：每个子块必须属于一个真实存在的父文档，不能产生“孤儿子块”。

### 5.4 级联删除 `ON DELETE CASCADE`

```sql
REFERENCES rag_documents(id)
ON DELETE CASCADE
```

作用：删除父文档时，PostgreSQL 自动删除它的所有子块。

```text
删除 SSE.md 父记录
→ 自动删除 SSE.md 的全部 chunks
```

它只作用于父表删除，不代表更新父文档时会自动重建子块。

---

## 6. TypeScript 类型如何映射到 PostgreSQL

| TypeScript | PostgreSQL | 示例 |
|---|---|---|
| `string` | `text` | 路径、标题、正文、Hash |
| `number` | `integer` | `sequence`、`splitIndex` |
| `boolean` | `boolean` | `needsVision` |
| `string[]` | `text[]` | `headingPath` |
| 对象或数组 | `jsonb` | `frontmatter`、`imageRefs` |
| `Date` | `timestamptz` | 修改时间、索引时间 |
| `number[1024]` | `vector(1024)` | BGE-M3 Embedding |

`jsonb` 适合结构不完全固定、但仍需要保留结构的数据。当前项目会先调用：

```ts
JSON.stringify(document.frontmatter)
```

SQL 再通过：

```sql
$6::jsonb
```

转换成 PostgreSQL 的 JSONB。

---

## 7. 用只读 SQL 观察真实数据

### 7.1 查看文档和子块数量

```sql
SELECT count(*) AS documents FROM rag_documents;
SELECT count(*) AS chunks FROM rag_chunks;
```

这两个数字应该能对应 `stats` 命令。

### 7.2 查看最近索引的父文档

```sql
SELECT source_path, title, indexed_at
FROM rag_documents
ORDER BY indexed_at DESC
LIMIT 5;
```

### 7.3 查看 SSE 父文档，不输出全文

```sql
SELECT
  id,
  source_path,
  title,
  left(content_hash, 12) AS hash_prefix,
  modified_at,
  indexed_at
FROM rag_documents
WHERE source_path = 'C-前端学习/node/SSE.md';
```

`left(content_hash, 12)` 只显示 Hash 前 12 位，方便观察。

### 7.4 查看 SSE 的全部子块

```sql
SELECT
  sequence,
  heading_path,
  split_index,
  needs_vision,
  char_length(content) AS content_chars
FROM rag_chunks
WHERE source_path = 'C-前端学习/node/SSE.md'
ORDER BY sequence;
```

这条查询能验证：

- 子块顺序；
- 完整标题路径；
- 长块拆分序号；
- 图片风险标记；
- 每个子块的字符数。

### 7.5 使用 JOIN 同时读取父子数据

```sql
SELECT
  d.title AS document_title,
  c.sequence,
  c.heading_path,
  left(c.content, 80) AS preview
FROM rag_documents AS d
JOIN rag_chunks AS c
  ON c.parent_id = d.id
WHERE d.source_path = 'C-前端学习/node/SSE.md'
ORDER BY c.sequence;
```

`JOIN` 的作用是根据：

```text
c.parent_id = d.id
```

把父文档信息和对应子块拼成一行结果。

---

## 8. Node.js 如何执行 SQL

`RagDatabase` 使用连接池：

```ts
const pool = new Pool({ connectionString });
```

连接池不是每条 SQL 都重新创建数据库进程，而是管理可复用连接。

查询 Hash：

```ts
await pool.query(
  "SELECT source_path, content_hash FROM rag_documents",
);
```

带外部数据时使用参数化 SQL：

```ts
await pool.query(
  "SELECT * FROM rag_documents WHERE source_path = $1",
  [sourcePath],
);
```

不要拼接：

```ts
// 不推荐
`SELECT * FROM rag_documents WHERE source_path = '${sourcePath}'`
```

参数化 SQL 的作用：

- 避免引号和特殊字符破坏 SQL；
- 降低 SQL 注入风险；
- 让 SQL 结构和参数值分离。

---

## 9. 为什么更新文档需要事务

更新一篇文档不是一个动作，而是多个动作：

```text
1. 更新父文档
2. 删除全部旧子块
3. 插入新子块1
4. 插入新子块2
5. ……
```

如果没有事务，第 5 个子块插入失败：

```text
父文档已经更新
旧子块已经删除
数据库只剩部分新子块
```

这是一份不完整的索引。

当前实现：

```mermaid
flowchart TD
    A["BEGIN"] --> B["UPSERT 父文档"]
    B --> C["删除全部旧子块"]
    C --> D["逐个插入新子块"]
    D -->|"全部成功"| E["COMMIT"]
    D -->|"任一步失败"| F["ROLLBACK"]
    F --> G["恢复事务开始前的旧数据"]
```

事务提供的是“全成功或全失败”的原子性。

### `COMMIT` 与 `ROLLBACK`

- `COMMIT`：确认并永久保存本次事务修改；
- `ROLLBACK`：撤销本次事务中的全部修改。

因此预测题的答案是：插入第 5 个新子块失败后，原来的 10 个旧子块仍然存在。

### 为什么使用同一个 client

事务必须始终使用同一条数据库连接：

```ts
const client = await pool.connect();

await client.query("BEGIN");
await client.query(/* 更新父文档 */);
await client.query(/* 删除旧子块 */);
await client.query(/* 插入新子块 */);
await client.query("COMMIT");
```

最后执行：

```ts
client.release();
```

把连接归还连接池。

---

## 10. UPSERT 是什么

父文档可能是第一次索引，也可能是重新索引：

```sql
INSERT INTO rag_documents (...)
VALUES (...)
ON CONFLICT (id)
DO UPDATE SET ...;
```

含义：

```text
id 不存在 → INSERT 新记录
id 已存在 → UPDATE 原记录
```

这就是 UPSERT：`INSERT + UPDATE`。

当前冲突判断使用父文档 `id`。它由相对路径生成，所以路径不变时，修改正文仍会更新原记录。

---

## 11. 为什么更新时先删除全部旧子块

假设旧文件有：

```text
A、B、C、D 四个子块
```

修改后只有：

```text
A、B、E 三个子块
```

如果只执行新增和更新，还必须准确判断：

- A、B 是否变化；
- C、D 是否已经删除；
- E 是否新增；
- 标题顺序是否改变。

当前第一版选择更简单的方式：

```text
父文档发生变化
→ 删除 A、B、C、D
→ 插入新的 A、B、E
```

优点是结果可靠、逻辑简单；缺点是一个小修改也会重写该文档的全部子块。

---

## 12. `vector(1024)` 是什么

```sql
embedding vector(1024) NOT NULL
```

含义：每个子块必须保存一个包含 1024 个数字的向量。

1024 来自当前 BGE-M3 模型的输出维度，不是数据库自行决定的。

可以只查看维度，不打印完整向量：

```sql
SELECT
  source_path,
  sequence,
  vector_dims(embedding) AS dimensions
FROM rag_chunks
LIMIT 5;
```

预期 `dimensions` 都是：

```text
1024
```

文档向量与问题向量必须维度相同，才能计算距离。

---

## 13. 余弦距离与相似度

pgvector 的余弦距离运算符：

```sql
embedding <=> query_vector
```

当前代码把距离转换为相似度：

```sql
1 - (embedding <=> query_vector) AS similarity
```

理解为：

```text
余弦距离越小 → 方向越接近
相似度越大   → 文本语义通常越相关
```

数据库负责快速计算距离，但“相似度高”不等于“答案一定正确”，最终仍需要 Recall@3 和引用检查。

---

## 14. HNSW 索引解决什么问题

如果没有向量索引，数据库需要把问题向量与每个子块逐一比较：

```text
问题向量
├─ 对比 chunk 1
├─ 对比 chunk 2
├─ 对比 chunk 3
└─ ……对比所有 chunk
```

当前创建：

```sql
CREATE INDEX rag_chunks_embedding_hnsw_idx
ON rag_chunks
USING hnsw (embedding vector_cosine_ops);
```

HNSW 用额外的索引结构快速寻找附近向量，适合 Top-K 检索。

它是近似检索：速度更快，但理论上不保证每次都找到绝对精确的最近邻。当前 3335 个子块规模不大，使用它主要是为了建立真实向量数据库实践。

查看索引：

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('rag_documents', 'rag_chunks')
ORDER BY tablename, indexname;
```

---

## 15. 删除同步如何工作

摄入完成后执行：

```sql
DELETE FROM rag_documents
WHERE NOT (source_path = ANY($1::text[]));
```

含义：删除数据库中存在、但本次扫描结果中已经不存在的父文档。

随后依靠 `ON DELETE CASCADE` 自动删除其子块。

为了防止路径配置错误导致清库，代码有保护：

```ts
if (seenPaths.length === 0) {
  throw new Error("扫描结果为空，拒绝删除既有索引");
}
```

iCloud 临时读取失败的文件会加入 `retainedPaths`，因此不会被误判为已删除。

---

## 16. 三个最小实验

### 实验一：观察真实父子数据

依次运行本教程第 7 节的五条只读查询，回答：

- 当前父文档和子块分别有多少条？
- `SSE.md` 有多少个子块？
- 哪些子块的 `split_index` 大于 0？

### 实验二：验证增量更新

在不修改 Markdown 的情况下再次执行：

```bash
pnpm --filter @dkagent/rag-v2 run ingest
```

预期：

```text
indexedDocuments = 0
chunksEmbedded = 0
```

这证明 Hash 相同的父文档没有重新调用 Embedding，也没有重新写库。

### 实验三：安全观察事务回滚

进入 `psql`，使用临时表，不接触 RAG 数据：

```sql
BEGIN;

CREATE TEMP TABLE tx_demo (
  id integer PRIMARY KEY,
  name text NOT NULL
);

INSERT INTO tx_demo VALUES (1, 'before rollback');
SELECT * FROM tx_demo;

ROLLBACK;
```

临时表只属于当前连接；`ROLLBACK` 后，本次事务创建的表和数据都会撤销。

再执行：

```sql
SELECT * FROM tx_demo;
```

预期提示 `tx_demo` 不存在。

---

## 17. 当前阶段不需要学习的内容

暂时跳过：

- B-Tree 内部结构；
- MVCC 实现细节；
- 隔离级别推导；
- `EXPLAIN ANALYZE` 调优；
- 分区、主从复制和数据库集群；
- HNSW 参数调优；
- ORM。

这些都不是完成当前文字 RAG 的前置条件。

---

## 18. 验收题

1. 为什么 `rag_documents` 和 `rag_chunks` 是一对多关系？
2. `PRIMARY KEY`、`FOREIGN KEY`、`ON DELETE CASCADE` 分别解决什么问题？
3. 为什么更新父文档时，要在事务中删除旧子块并插入新子块？
4. 插入第 5 个新子块失败并执行 `ROLLBACK` 后，旧子块是否还存在？
5. `vector(1024)` 的 1024 来自哪里？
6. HNSW 索引与余弦相似度分别负责什么？

完成只读实验和口述后，才进入向量检索调用链。
