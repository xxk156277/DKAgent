## 1. 数据库解决什么问题

程序运行时，数据通常放在内存：

```typescript
const entries: KnowledgeEntry[] = [];
```

进程退出后，内存数据就消失了。

数据库负责把数据持久化：

```text
Markdown → KnowledgeEntry[] → 数据库文件
```

下一次启动程序，可以直接查询，不需要重新解析全部 Markdown。

## 2. SQLite 是什么

SQLite 是一个嵌入式关系型数据库。

传统数据库通常需要单独启动服务：

```text
Node.js → 网络 → MySQL/PostgreSQL 服务
```

SQLite 直接运行在 Node.js 进程中：

```text
Node.js
  └─ better-sqlite3
       └─ data/knowledge.db
```

它最终就是一个本地文件，不需要启动数据库服务器，适合 DKAgent 这种本地学习项目。

可以粗略类比前端：

| 前端概念 | SQLite |
|---|---|
| IndexedDB | 本地结构化存储 |
| Object Store | Table |
| 一条对象 | 一行数据 |
| 索引 | Database Index |
| 事务 | Transaction |

但 SQLite 的查询、约束和事务能力更完整。

---

## 3. 关系型数据库基础

### Table：表

表用于保存同一种结构的数据。

```text
knowledge
```

类似：

```typescript
KnowledgeEntry[]
```

### Row：行

每一道面试题是一行：

```text
knowledge
├─ 第 1 行：ReAct 怎么选
├─ 第 2 行：Agent Loop 是什么
└─ 第 3 行：Tool Calling 怎么工作
```

类似数组里的一个对象。

### Column：列

每行对象的属性：

```text
id
dimension
question
expert_answer
source_file
content
```

类似：

```typescript
interface KnowledgeEntry {
    id: string;
    question: string;
}
```

### Schema：表结构

SQL 建表语句相当于 TypeScript 类型：

```sql
CREATE TABLE knowledge (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    novice_answer TEXT
);
```

对应：

```typescript
interface KnowledgeEntry {
    id: string;
    question: string;
    noviceAnswer?: string;
}
```

其中：

- `TEXT`：字符串类型。
- `NOT NULL`：必须有值。
- `PRIMARY KEY`：唯一标识，不能重复。
- 没有 `NOT NULL`：允许为空。

区别是 TypeScript 只在编译期检查，数据库约束在程序运行时真正执行。

---

## 4. SQL 是什么

SQL 是操作关系型数据库的语言。

### 写入

```sql
INSERT INTO knowledge (id, question)
VALUES ('question-1', '什么是 Agent Loop？');
```

### 查询

```sql
SELECT *
FROM knowledge
WHERE id = 'question-1';
```

### 更新

```sql
UPDATE knowledge
SET question = 'Agent Loop 有什么作用？'
WHERE id = 'question-1';
```

### 删除

```sql
DELETE FROM knowledge
WHERE id = 'question-1';
```

合起来叫 CRUD：

```text
Create
Read
Update
Delete
```

---

## 5. Transaction：事务

假设离线建库有 384 条知识：

```text
删除旧数据
→ 插入第 1 条
→ 插入第 2 条
→ ...
→ 插入第 384 条
```

如果插入到第 200 条时程序报错，数据库可能只剩下半份数据。

事务保证这些操作是一个整体：

```text
BEGIN
→ 删除旧数据
→ 插入 384 条
→ 全部成功：COMMIT
→ 任意失败：ROLLBACK
```

效果是：

```text
要么全部成功
要么完全不变
```

这就是事务的原子性。

前端可以类比一次状态更新：

```typescript
setState((oldState) => {
    // 所有修改完成后一次性提交
    return newState;
});
```

---

## 6. Index：索引

如果没有索引，查询某个 ID 时，数据库可能需要逐行检查：

```text
第 1 行，不是
第 2 行，不是
...
第 384 行，找到了
```

索引类似书籍目录：

```text
Agent Loop → 第 36 页
RAG → 第 82 页
Tool Calling → 第 105 页
```

普通关系型数据库最常见的是 B-Tree 索引：

```sql
CREATE INDEX idx_knowledge_dimension
ON knowledge(dimension);
```

适合：

- 精确匹配
- 大小比较
- 范围查询
- 排序

例如：

```sql
WHERE dimension = '01-architecture-design'
```

但普通索引不擅长搜索大段文字。

---

## 7. FTS 是什么

FTS 是 Full-Text Search，全文检索。

它不是一种独立数据库，而是数据库提供的一种搜索能力。

SQLite 当前使用的是第五代全文检索模块，所以叫：

```text
FTS5
```

普通 SQL 模糊查询：

```sql
WHERE content LIKE '%Agent Loop%'
```

通常需要逐行扫描全文，数据量大时会变慢。

FTS5 会提前建立倒排索引。

### 倒排索引

普通数据结构是：

```text
文档 1 → Agent、Loop、工具
文档 2 → RAG、Embedding、检索
```

倒排索引反过来保存：

```text
Agent     → 文档 1、文档 3
Loop      → 文档 1
RAG       → 文档 2、文档 5
Embedding → 文档 2
```

搜索 `Agent` 时，可以直接找到相关文档，不需要扫描所有内容。

这与搜索引擎的核心结构相同。

---

## 8. FTS5 在 DKAgent 中的位置

我们有两张表：

```text
knowledge
    └─ 保存完整知识，是事实来源

knowledge_fts
    └─ 保存全文索引，是检索加速结构
```

它们通过 `rowid` 对应：

```text
knowledge.rowid = 10
          ↕
knowledge_fts.rowid = 10
```

搜索时：

```sql
SELECT knowledge.*
FROM knowledge_fts
JOIN knowledge
    ON knowledge.rowid = knowledge_fts.rowid
WHERE knowledge_fts MATCH 'Agent Loop';
```

执行过程：

```text
FTS 找到相关 rowid
→ 回到 knowledge 表
→ 取出完整问题、高手答和来源
```

---

## 9. Trigger 是什么

Trigger 是数据库事件监听器。

可以类比前端事件：

```typescript
button.addEventListener("click", handler);
```

数据库中：

```text
knowledge 插入一行
→ 自动触发 knowledge_after_insert
→ 同步更新 knowledge_fts
```

三类 Trigger：

```text
INSERT → 新增 FTS 索引
UPDATE → 更新 FTS 索引
DELETE → 删除 FTS 索引
```

这样 Repository 只需要操作 `knowledge`：

```typescript
repository.insert(entry);
```

不需要每次手动写：

```typescript
insertKnowledge(entry);
insertFts(entry);
```

避免两张表不同步。

---

## 10. trigram 是什么

FTS 需要先把文本拆成可索引的 Token。

英文容易按空格拆：

```text
Agent Loop requires max steps
↓
Agent / Loop / requires / max / steps
```

中文没有天然空格：

```text
如何防止Agent无限循环
```

`trigram` 会按连续三个字符切分：

```text
如何防
何防止
防止A
止Ag
Age
gen
...
```

这样用户搜索一段相近中文时，也更容易匹配。

我们计划使用：

```sql
tokenize = 'trigram'
```

但还没有验证当前 SQLite 是否支持，之后会实际运行兼容性检查。

---

## 11. 与 FTS 同类型的检索能力

| 类型 | 适合场景 | 示例 |
|---|---|---|
| B-Tree 索引 | ID、分类、时间、范围 | SQLite/MySQL/PostgreSQL |
| 全文检索 | 关键词和文本相关性 | SQLite FTS5、MySQL FULLTEXT |
| Trigram | 中文子串、拼写模糊匹配 | FTS5 trigram、PostgreSQL pg_trgm |
| 倒排搜索引擎 | 大规模全文搜索 | Elasticsearch、OpenSearch |
| 向量检索 | 语义相似度 | pgvector、Milvus、Qdrant |
| 混合检索 | 关键词 + 语义 | FTS/BM25 + Embedding |

### 全文检索

```text
用户：Agent Loop
文档：Agent Loop 如何设置终止条件
```

关键词相同，容易命中。

### 向量检索

```text
用户：怎样避免模型一直调用工具？
文档：Agent Loop 的最大循环次数
```

文字不同，但语义接近，Embedding 更容易命中。

### Hybrid

```text
FTS5 关键词结果
+
Embedding 语义结果
→ 融合排序
```

这是后续完整 RAG 的方向。

---

## 12. 当前离线建库的数据路径

```text
KnowledgeEntry[]
→ Repository 开启事务
→ INSERT knowledge
→ Trigger 自动更新 knowledge_fts
→ COMMIT
```

未来查询：

```text
用户问题
→ FTS5 MATCH
→ 得到 rowid 和 rank
→ JOIN knowledge
→ 返回 KnowledgeSearchHit
```

你现在只需要抓住三个核心：

> `knowledge` 保存事实，`knowledge_fts` 保存搜索索引，Trigger 保证二者同步。