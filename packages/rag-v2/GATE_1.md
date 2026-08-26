# 第一关：把 Markdown 变成父文档和标题子块

> 本关只学习索引前的“文档解析”。不学习 Embedding、PostgreSQL、向量检索和生成答案。

## 1. 本关目标

学完后，你应该能脱离代码回答四个问题：

1. 为什么一个 Markdown 文件既要保存为父文档，又要拆成多个子块？
2. `SSE.md` 会被拆成哪些子块，代码块里的 `#` 为什么不是标题？
3. 文件正文、标题或路径变化时，哪些 ID 和哈希会变化？
4. 当前切块策略会在哪些真实文档上失效？

本关的验收不是“命令运行成功”，而是你能预测解析结果并解释设计取舍。

---

## 2. 先看整个 RAG，再框住本关

完整链路是：

```text
Markdown 文件
  ↓  本关
扫描文件 → 解析 Markdown → 父文档 + 标题子块
  ↓  后续关卡
Embedding → pgvector → Top-K → 上下文 → LLM 回答
```

目前数据库中已经有向量，不代表第一关已经验收。之前的 `ingest` 和 `search` 只能证明链路跑通过，不能证明你理解了它。

---

## 3. 为什么要“文件父文档 + 标题子块”

假设 `SSE.md` 有 3000 字，用户只问：

> SSE 和普通 HTTP 有什么区别？

### 只使用整篇文件

- 优点：上下文完整。
- 问题：内容太多，主题被稀释；问题只对应其中一个标题。

### 只保存切碎的小块

- 优点：检索定位准确。
- 问题：回答复杂问题时可能缺少前后文，也不容易恢复原文件。

### 当前方案

- `ParentDocument`：整个 Markdown 文件，负责来源、完整正文、元数据和增量更新。
- `ChildChunk`：一个标题段落，负责精准检索。

一句话记忆：

> 用小块找到位置，用父文档补足上下文。

注意：当前搜索结果主要返回命中的子块；“父文档补上下文”是在生成阶段根据文档长短和相邻块完成，不等于每次都把整篇父文档交给模型。

---

## 4. 两个核心数据结构

代码位置：[`src/domain/types.ts`](src/domain/types.ts)

### ParentDocument

```ts
interface ParentDocument {
    id: string; // sha256(相对路径)
    sourcePath: string; // 例如 C-前端学习/node/SSE.md
    title: string; // 第一个标题；没有标题时用文件名
    content: string; // 完整原始 Markdown
    contentHash: string; // sha256(完整原文)
    frontmatter: Record<string, unknown>;
    modifiedAt: Date;
}
```

父文档回答的是：**它来自哪里、完整内容是什么、是否发生变化。**

### ChildChunk

```ts
interface ChildChunk {
    id: string;
    parentId: string;
    sourcePath: string;
    headingPath: string[]; // 完整标题路径
    headingOrdinal: number; // 同路径标题出现的次序，从 0 开始
    splitIndex: number; // 长标题块拆分后的次序
    content: string; // 标题和该标题下的正文
    contentHash: string;
    imageRefs: ImageReference[];
    needsVision: boolean;
}
```

子块回答的是：**用户的问题最可能对应文件中的哪个局部。**

---

## 5. 用真实 `SSE.md` 预测切块

真实文件：

```text
大康note/C-前端学习/node/SSE.md
```

文件开头的结构可以简化成：

````md
## SSE 是什么

正文……

## SSE 适合什么场景

正文……

## SSE 和普通 HTTP 的区别

正文……

```txt
客户端请求 -> 服务端处理
```

## SSE 的响应头

正文……
````

解析器会得到类似结果：

```ts
ParentDocument {
  sourcePath: "C-前端学习/node/SSE.md",
  title: "SSE 是什么",
  content: "整篇原始 Markdown"
}

ChildChunk[] = [
  { headingPath: ["SSE 是什么"], content: "## SSE 是什么\n……" },
  { headingPath: ["SSE 适合什么场景"], content: "## SSE 适合什么场景\n……" },
  { headingPath: ["SSE 和普通 HTTP 的区别"], content: "## SSE 和普通 HTTP 的区别\n……" },
  { headingPath: ["SSE 的响应头"], content: "## SSE 的响应头\n……" },
]
```

关键点：

- 这个文件从 H2 开始，没有 H1，因此标题路径就是单层数组。
- 每个子块保留标题本身，标题也是重要的检索语义。
- fenced code block 中的 `#` 或示例文字不会被当成 Markdown 标题，因为解析器读取的是 Markdown AST，不是逐行正则匹配。
- 后面的 H3（如 ``### `data` ``）会继承当前 H2，形成 `['常见字段', '`data`']` 这样的完整路径。

---

## 6. 当前代码的数据流

代码阅读顺序：

1. [`src/ingestion/scanner.ts`](src/ingestion/scanner.ts)：根据白名单找到文件并读取原文。
2. [`src/ingestion/parser.ts`](src/ingestion/parser.ts)：把一个文件转成一个父文档和多个子块。
3. [`src/domain/types.ts`](src/domain/types.ts)：定义解析结果的形状。

核心调用关系：

```text
scanVault()
  ├─ fast-glob 找到 Markdown 路径
  ├─ readFile() 读取文件
  └─ parseMarkdownDocument()
       ├─ gray-matter 分离 frontmatter
       ├─ remark-parse 生成 Markdown AST
       ├─ extractSections() 按 H1/H2/H3 划分标题段
       ├─ splitOversized() 拆分超长标题段
       ├─ extractImageReferences() 提取图片引用
       └─ 生成 ParentDocument + ChildChunk[]
```

### `extractSections()` 做了什么

它只把 H1/H2/H3 当作切块边界，并维护标题栈：

```md
# Agent

## RAG

### 父子索引
```

得到：

```ts
["Agent", "RAG", "父子索引"];
```

若标题前还有正文，会额外生成一个 `headingPath: []` 的前言块。完全无标题的短文件也会生成一个默认块。

### `splitOversized()` 做了什么

- 默认上限：约 1600 个 JavaScript 字符。
- 默认重叠：160 个字符。
- 优先在段落空行或换行附近截断。
- 重叠用于降低答案恰好落在切割边界时的信息损失。

这里按“字符”而不是模型 token 切分，所以 1600 只是工程近似值，不是严格的 token 预算。

### 图片处理做了什么

当前只识别并记录：

```md
![结果](assets/result.png)
![[截图.png|配置截图]]
```

如果去掉标题和图片语法后，可见文字不足 120 个字符，则标记：

```ts
needsVision = true;
```

它的含义是“仅靠文本可能答不好”，不是“系统已经看懂图片”。当前项目仍是文字 RAG。

---

## 7. ID 与 Hash：身份和内容要分开

这是本关最重要、也最容易混淆的部分。

```text
parentId          = hash(相对路径)
parent.contentHash = hash(完整原文)
chunkId           = hash(parentId + 标题路径 + 同名次序 + 拆分序号)
chunk.contentHash = hash(子块内容)
```

预测变化：

| 操作                           | parentId | parent contentHash | chunkId                     | chunk contentHash |
| ------------------------------ | -------- | ------------------ | --------------------------- | ----------------- |
| 只改某段正文                   | 不变     | 变化               | 通常不变                    | 对应块变化        |
| 修改标题文字                   | 不变     | 变化               | 该标题及其后代变化          | 对应块变化        |
| 文件改名或移动                 | 变化     | 通常不变           | 全部变化                    | 通常不变          |
| 同标题下内容过长，拆分边界变化 | 不变     | 变化               | splitIndex 身份仍按序号生成 | 受影响块变化      |

设计目的：正文修改后仍能认出“这是同一个文件、同一个标题位置”，同时通过 `contentHash` 判断需要重新索引。

边界：如果在多个同名标题前插入一个同名标题，后续 `headingOrdinal` 会顺移，因此稳定 ID 只能做到“对常见编辑稳定”，不是永远稳定。

---

## 8. 当前策略的已知边界

先知道边界，后面评估失败时才不会盲目加模型：

1. 只按 H1/H2/H3 切块，H4/H5/H6 不形成新子块。
2. 超长块按字符窗口拆分，可能切开代码块或一段完整步骤。
3. 图片只记录引用和邻近文字，无法理解截图中的按钮、箭头和配置值。
4. 标题写得含糊（如“问题一”“其他”）时，子块的检索语义会变弱。
5. 一个答案横跨多个文件时，单个标题子块可能只召回部分证据。

这些是后续 20 题评估要观察的问题，不在第一关提前优化。

---

## 9. 最小实验

先只运行解析器测试，不调用 Embedding，也不访问数据库：

```bash
cd /Users/xuxiaokang/apps/DKAgent
pnpm --filter @dkagent/rag-v2 exec tsx --test test/parser.test.ts
```

对应测试：[`test/parser.test.ts`](test/parser.test.ts)

你要阅读测试名称，并确认它覆盖了：

- H1/H2/H3 标题路径；
- 代码块中的 `#`；
- 同名标题 ordinal；
- 无标题文件和长块重叠；
- Markdown/Obsidian 图片；
- 稳定 ID 与内容哈希。

命令全绿只代表实现符合这些测试，不代表真实语料切块一定合理。

---

## 10. 先预测，再验收

不要运行搜索。先手工预测下面这段 Markdown：

````md
---
tags: [rag]
---

# 素材管理

这是一段总览。

## 素材为空

先检查素材组是否生效。

```ts
# 这里不是标题
const status = 'empty'
```

### 排查步骤

第一步检查配置，第二步检查数据。

## 素材为空

这是另一种异常。

![[素材配置.png|配置截图]]
````

请回答：

1. 会生成几个子块？每个 `headingPath` 是什么？
2. 两个“素材为空”的 `headingOrdinal` 分别是什么？
3. 哪个块可能是 `needsVision=true`？为什么？
4. 只把“另一种异常”改成“缓存异常”后，哪些 ID/Hash 会变化？

## 11. 第一关验收标准

你需要用自己的话完成以下口述，不要求背函数名：

- [ ] 我能解释父文档和子块各自解决什么问题。
- [ ] 我能预测一段 Markdown 的标题路径和子块数量。
- [ ] 我能解释 AST 为什么不会把代码块中的 `#` 当标题。
- [ ] 我能区分 ID（身份）和 contentHash（内容变化）。
- [ ] 我知道长块重叠和 `needsVision` 的作用及局限。
- [ ] 我能指出至少两个可能导致真实检索失败的切块问题。

验收回复模板：

```text
预测题：
1. ……
2. ……
3. ……
4. ……

我的理解：父文档……；子块……；小块检索、大块补上下文是因为……

我认为当前策略最可能遇到的问题是：……
```

只有完成口述并明确说“第一关验收通过”，才进入第二关 Embedding 与增量入库。
