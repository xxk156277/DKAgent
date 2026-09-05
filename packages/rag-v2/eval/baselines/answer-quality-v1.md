# 完整问答基线状态（2026-09-02）

状态：`needs_verification`。

已实现 20 条正例 + 2 条拒答例的完整基线命令，指标包括 Recall@3、模型裁判的事实覆盖率、引用支持率、拒答准确率、端到端延迟，以及 Embedding / 生成 / 验证 Token。

运行命令：

```bash
# 中文注释：显式运行22题完整问答基线，会调用DeepSeek生成和语义验证
pnpm --filter @dkagent/rag-v2 rag baseline
```

当前阻塞：仓库根 `.env` 没有可用的 `DEEPSEEK_API_KEY`，真实单题问答在模型调用前被配置校验拒绝。因此本文件不填写事实覆盖、引用支持、拒答、生成延迟或 Token 数值，避免把未运行结果写成基线。
