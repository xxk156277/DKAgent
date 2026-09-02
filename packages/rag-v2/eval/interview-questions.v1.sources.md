# 真实面经 20 题来源说明

## 使用边界

- 题目由 AI 从近两年的公开面经中抽取并做轻量标点、指代归一，不凭空生成面试题。
- `relevantSourcePaths` 表示人工标注的全部相关父文档，不是“任选一个即可”的候选列表；单题 Recall@3 按 Top-3 命中数除以该列表总数计算。
- `expectedFacts` 来自当前“大康note”数据库快照对应的本地文档，不代表面经作者给出的答案。
- 本集为 20 道可回答的 Recall@3 正例；拒答题应单独维护，避免把负例混入检索召回率分母。
- 本轮未接入小红书图片 OCR，因此来源仅覆盖网页可读取的牛客正文，不能宣称覆盖小红书图片中的题目。

## Agent 题（1～10）

主要来源：

- [字节大模型应用开发一面，面傻了](https://www.nowcoder.com/discuss/916420927619928064)
- [联想-AI应用开发-面经](https://www.nowcoder.com/discuss/869169098146537472)

题目覆盖 RAG 流程、Chunk、检索排查、混合召回、Rerank、RAG 与微调、Memory、上下文压缩、Tool 设计和异常恢复。

## 前端题（11～20）

主要来源：

- [字节前端一面面经](https://www.nowcoder.com/discuss/793213320655306752)
- [字节-前端-一面](https://www.nowcoder.com/discuss/806542679122145280)
- [字节广告前端面经](https://www.nowcoder.com/discuss/786037843704479744)
- [美团前端面经](https://www.nowcoder.com/discuss/797941590240018432)

题目覆盖 SSE、React Hooks、Effect、信息流长列表、Tree Shaking、模块规范、性能指标和 HTTP 版本。
