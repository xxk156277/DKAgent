## 数据流

```text
    learn-agent-interview/**/*.md
    → Markdown Parser
    → KnowledgeEntry[]
    → SQLite knowledge 表
    → knowledge_fts 索引
    → 建库统计与固定查询验证
```

## 目录设计

```text
    src/knowledge/
    ├── types.ts        # 领域类型
    ├── parser.ts       # Markdown 字符串转 KnowledgeEntry[]
    ├── database.ts     # SQLite 连接与 Schema
    ├── repository.ts   # 重建、写入、统计和 FTS 验证查询
    ├── build.ts        # 扫描文件并编排离线建库
    └── index.ts        # 对外导出
```

Parser 是纯函数，不读文件、不连接数据库。Repository 不解析 Markdown。Build 只负责编排。

## Parser 规则

- 支持 `## Q：` 和 `### Q:`。
- 提取问题、高手答、可选的新手答和差距分析。
- 缺少高手答的问题跳过并计数。
- 没有问题块的文档不作为整篇知识写入。
- 不调用模型修复格式，保证构建可重复。

举例：

```text
### Q：ReAct 和 Plan-and-Execute 怎么选？

**新手答**：“复杂任务用 ReAct。”

**高手答**：

应该根据任务的不确定性选择。需要根据外部反馈动态调整时使用 ReAct；流程固定、可预测时使用 Plan-and-Execute。

**差距在哪**：新手没有给出明确的判断标准。

Parser转化后：

{
    entries: [
        {
            id: "01-architecture-design/index.md#q-1",
            dimension: "01-architecture-design",
            question: "ReAct 和 Plan-and-Execute 怎么选？",
            expertAnswer:
                "应该根据任务的不确定性选择。需要根据外部反馈动态调整时使用 ReAct；流程固定、可预测时使用 Plan-and-Execute。",
            noviceAnswer:
                "复杂任务用 ReAct。",
            gapAnalysis:
                "新手没有给出明确的判断标准。",
            sourceFile:
                "01-architecture-design/index.md",
            content:
                "问题：ReAct 和 Plan-and-Execute 怎么选？\n\n" +
                "高手答：应该根据任务的不确定性选择。需要根据外部反馈动态调整时使用 ReAct；流程固定、可预测时使用 Plan-and-Execute。\n\n" +
                "差距分析：新手没有给出明确的判断标准。"
        }
    ],

    skipped: []
}

```

## 数据库设计

`knowledge` 保存原始结构化数据；`knowledge_fts` 索引 `question`、`expert_answer`、`gap_analysis` 和 `content`。

普通表与 FTS 表通过 Trigger 同步。中文检索优先验证 FTS5 `trigram` tokenizer；不支持时明确报错，不静默切换。

Repository 在单个事务中清空并批量插入。解析结果为 0 时拒绝清空数据库。

默认输出数据库：`data/knowledge.db`。

## CLI

```bash
npm run kb:build
```

默认读取 `learn-agent-interview`，完成后输出扫描文件数、成功知识数、跳过数、维度数和数据库路径。
