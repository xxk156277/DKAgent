
`pg` 里的 `Pool` 是连接池，适合 Web/服务端应用，避免每次请求都新建数据库连接。

### 1. 创建连接池

```ts
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,           // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

### 2. 执行查询

```ts
const result = await pool.query(
  "SELECT * FROM rag_documents WHERE id = $1",
  ["doc_001"]
);
```

返回：
```ts
result.rows
result.rowCount
```

### 3. 事务

```ts
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("INSERT INTO ...");
  await client.query("UPDATE ...");
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```

这是你现在代码里 `replaceDocument` 的典型用法。

### 4. 直接使用单个连接

```ts
const client = await pool.connect();
try {
  const res = await client.query("SELECT now()");
  console.log(res.rows[0]);
} finally {
  client.release();
}
```

### 5. 错误处理

```ts
pool.on("error", (err) => {
  console.error("Unexpected pool error:", err);
});
```

### 6. 关闭连接池

```ts
await pool.end();
```


## 在你的项目里的常见模式

你的代码中最常用的是：

```ts
const result = await this.pool.query("SELECT ...");
```

以及：

```ts
const client = await this.pool.connect();
try {
  await client.query("BEGIN");
  ...
} finally {
  client.release();
}
```

这个模式适合：
- 读写数据库
- 事务更新
- 批量插入 chunk / embedding
- 连接复用，减少资源开销

## 直观理解

`Pool` 就像“数据库连接池工厂”：

- 不是每次都建一个新连接
- 先准备一批连接放着
- 需要时借一个，使用完归还
- 这样更快、更稳定

如果你愿意，我也可以直接按你这个 RAG 项目的 `database.ts` 代码，给你写一份“`pool.query` / `pool.connect` / 事务”的实战示例。