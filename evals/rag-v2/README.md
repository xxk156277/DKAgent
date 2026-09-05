# RAG v2 Promptfoo 评估

本目录使用 Promptfoo 对真实 `rag-v2` 问答链路做独立语义评估，不替代项目已有的确定性 `Recall@3` 基线。

## 数据流

```text
20 条可回答问题 + 2 条拒答问题
  -> RagPromptfooProvider
  -> Hybrid 检索与上下文组装
  -> DeepSeek 生成和项目内引用验证
  -> Promptfoo 使用 DeepSeek 进行语义评分
```

Provider 返回结构化 `{ answer, context, status, sources }`。四项语义断言分别读取最终答案和实际提供给生成模型的上下文：

| Promptfoo 指标 | 本项目含义 |
| --- | --- |
| `context-recall` | `expectedFacts` 中的事实是否出现在上下文中 |
| `context-relevance` | 上下文与问题是否相关，作为 Context Precision 的近似指标 |
| `answer-relevance` | 最终回答是否回应问题 |
| `context-faithfulness` | 最终回答中的陈述是否得到上下文支持 |
| `is-refusal` | 无答案问题是否拒答 |

注意：Promptfoo 没有直接名为 `context-precision` 的内置断言，因此本项目明确使用 `context-relevance` 作为代理指标，不能把两者宣称为完全相同。

## 运行条件

仓库根目录 `.env` 必须提供：

```dotenv
# 中文注释：查询和文档使用的 Embedding 服务密钥
SILICONFLOW_API_KEY=

# 中文注释：RAG 生成、项目内引用验证和 Promptfoo 裁判共用的模型密钥
DEEPSEEK_API_KEY=
```

PostgreSQL 必须已经迁移并完成知识库摄入。

## 命令

```bash
# 中文注释：运行无需外部模型的映射测试
pnpm test:rag-eval

# 中文注释：检查 Promptfoo 接入代码的类型
pnpm typecheck:rag-eval

# 中文注释：运行22题真实语义评估，默认串行且不使用缓存
pnpm eval:rag

# 中文注释：只运行第1题，用于配置和真实服务冒烟
pnpm eval:rag -- --filter-first-n 1

# 中文注释：查看本地 Promptfoo 评估界面
pnpm exec promptfoo view .dkagent/promptfoo-rag
```

## 当前边界

- 第一版不设置评分门槛，只建立分数基线；获得稳定结果并人工抽查后再设置 CI 门禁。
- 四项语义指标依赖裁判模型，存在波动，不能替代确定性的父文档 `Recall@3`。
- 正例执行 RAG 生成、项目内引用验证和四项 Promptfoo 裁判；拒答例只执行 `is-refusal`。
- 评估结果保存在被 Git 忽略的 `.dkagent/promptfoo-rag`，不会上传或分享。

