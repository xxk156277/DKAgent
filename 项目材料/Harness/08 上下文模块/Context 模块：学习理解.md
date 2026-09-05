
> 配套图集：[context-diagrams.drawio](context-diagrams.drawio)（页面 01–03）。

## 1. 模块是什么

Context 模块负责把 `AgentLoop` 的完整会话历史，转换为一次符合 Token 预算的模型请求快照。

```text
完整历史 + 摘要状态 + Tool Schema + Token 预算
                    ↓
              ContextManager
                    ↓
System Prompt + 历史摘要 + 最近原文 + Tool Schema
```

核心边界：

- `AgentLoop.messages` 保存当前进程内的完整原始历史，不因压缩而修改。
- `AgentLoop.contextState` 只保存摘要和第一条保留原文的位置。
- `ContextManager` 无状态，只构建本轮 `ContextSnapshot`。
- Context 不负责跨进程持久化、跨会话 Memory、RAG 召回和业务 Tool 执行。

## 2. 核心组件

| 组件 | 职责 |
|---|---|
| `AgentLoop` | 持有完整消息和摘要状态，发起每轮 Context 构建。 |
| `ContextManager` | 计算预算，选择消息，组织摘要和删除兜底。 |
| `groupContextMessages` | 将 Tool Call 与对应 Tool Result 组成不可拆分组。 |
| `ProviderTokenCounter` | 把 Provider 的 Token 计数能力适配为 Context 接口。 |
| `Compressor` | 文本截断、Tool JSON 压缩、历史序列化和模型摘要。 |
| `Tracer` | 记录阈值判断、压缩计划、摘要调用和最终指标。 |

Token 预算关系：

```ts
availableInputTokens = maxContextTokens - reservedOutputTokens;
triggerTokens = availableInputTokens * 0.8;
targetTokens = availableInputTokens * 0.6;
rawMessageBudget = targetTokens - fixedTokens - maxSummaryTokens;
```

- `availableInputTokens` 是输入硬上限。
- 80% 是压缩触发线，60% 是压缩后的期望目标，不是第二个硬上限。
- `fixedTokens` 包含固定 System Prompt 和 Tool Schema。

## 3. 一次请求怎么走

1. `AgentLoop` 把用户消息追加到完整历史，再构建 `ContextBuildInput`。
2. Context 从 `firstKeptMessageIndex` 开始读取仍需保留原文的消息，并临时注入已有摘要。
3. 未超过 80% 时，直接返回摘要加最近原文的请求快照。
4. 超过 80% 时，先按完整消息组寻找切点：旧前缀进入摘要，最近消息保留原文。
5. `Compressor` 将“已有摘要 + 新增旧历史”生成新的结构化摘要。
6. 新摘要只进入本轮 System Prompt；新边界通过 `nextContextState` 返回给 `AgentLoop`。
7. 摘要失败或摘要后仍超预算时，按时间顺序整组删除最旧的非必留消息。

必须保护的结构：

- 最后一条 User 消息及其后的当前 Agent Run。
- Assistant Tool Call 与全部对应 Tool Result。
- 固定 System Prompt、Tool Schema 和当前有效摘要。

摘要固定保留：目标、限制与偏好、进度、阻塞、关键决定、下一步和关键上下文。

## 4. 当前做到哪里

已实现：

- Token 硬预算、80%/60% 水位、Tool 消息完整分组。
- 当前会话内的增量摘要、摘要边界和删除兜底。
- Context 构建与摘要过程 Trace、确定性测试和类型检查。

当前边界：

- Token 计数仍取决于 Provider；OpenAI-Compatible 实现目前是近似估算。
- `firstKeptMessageIndex` 依赖消息只追加，暂不支持持久化、插入和并发修改。
- `compressToolOutput()` 已提供，但主快照尚未主动压缩每个保留中的 Tool Result；摘要输入会按字符截断 Tool Result。
- 摘要状态只在当前进程、当前会话中存在，程序重启后丢失。
- 自动化测试已覆盖主分支；真实长对话摘要质量尚未形成正式评估结论。

代码入口：

- `packages/agent/src/agent/loop.ts`
- `packages/agent/src/context/manager.ts`
- `packages/agent/src/context/compressor.ts`
- `packages/agent/src/context/grouper.ts`
- `packages/agent/src/context/provider-token-counter.ts`
- `packages/agent/src/context/types.ts`
