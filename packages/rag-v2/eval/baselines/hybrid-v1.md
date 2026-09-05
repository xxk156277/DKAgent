# Hybrid v1 基线（2026-09-02）

数据集与数据库快照同 `dense-before-hybrid.md`。

运行命令：

```bash
# 中文注释：运行 BM25 + Dense + RRF 的 20 题 Recall@3 基线
pnpm --filter @dkagent/rag-v2 rag evaluate eval/interview-questions.v1.jsonl --strategy hybrid
```

复用 BM25 索引后的结果：

| 指标 | Dense | Hybrid |
|---|---:|---:|
| 父文档 Recall@3 | 0.85 | 0.90 |
| 平均检索延迟 | 176 ms | 169 ms |
| Embedding tokens | 312 | 312 |

变化：`Tool 的设计原则` 与 `ESM 和 CommonJS` 两题由 0.5 提升到 1；`过度使用 useEffect` 的相关文档命中发生变化但仍为 0.5。该表只记录同一评估集上的观察值，不能外推为线上提升。

补充：第一次未复用 BM25 索引时 Hybrid 平均延迟为 418 ms。加入进程内缓存后复测为 169 ms；单次延迟受网络波动影响，应看多轮分布而不是把一次均值当 SLA。
