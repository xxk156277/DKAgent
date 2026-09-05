# Dense 改造前基线（2026-09-02）

数据集：`eval/interview-questions.v1.jsonl`，20 条可回答问题。

运行命令：

```bash
# 中文注释：运行改造前的 Dense-only Recall@3 基线，不调用 DeepSeek
pnpm --filter @dkagent/rag-v2 rag evaluate eval/interview-questions.v1.jsonl
```

结果：

| 指标 | 数值 |
|---|---:|
| 父文档 Recall@3 | 0.85 |
| 平均检索延迟 | 176 ms |
| Embedding tokens | 312 |
| 文档 / 子块快照 | 388 / 3747 |

未满分问题：

| 问题 | Recall@3 |
|---|---:|
| Tool 的设计原则是什么？ | 0.5 |
| 哪些 React Hooks 可以优化组件渲染？ | 0.5 |
| 过度使用 useEffect 导致多次渲染，应该怎么优化？ | 0.5 |
| 信息流长列表应该怎么做性能优化？ | 0.5 |
| ESM 和 CommonJS 有什么区别？ | 0.5 |
| HTTP/1.1、HTTP/2 和 HTTP/3 的主要区别是什么？ | 0.5 |

说明：多相关文档题按“命中相关父文档数 / 全部相关父文档数”计算，因此 0.5 表示两篇相关文档只命中一篇。该结果只证明检索，不证明答案完整、引用正确或拒答成功。
