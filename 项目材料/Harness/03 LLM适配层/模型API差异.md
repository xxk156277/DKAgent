结合你 `provider.ts` 里的 `LLMProvider` 抽象，我按**实现这个接口时最关心的维度**来对比这三家 API 的差异：


## 1. 基础请求格式

| 维度            | OpenAI                                      | Anthropic                                      | DeepSeek                           |
| ------------- | ------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| Base URL      | `api.openai.com/v1`                         | `api.anthropic.com/v1`                         | `api.deepseek.com/v1`（兼容 OpenAI）   |
| 请求体结构         | `{ model, messages, ... }`                  | `{ model, messages, system, max_tokens, ... }` | 同 OpenAI（`system` 也在 `messages` 里） |
| `system` 消息   | 作为 `messages` 里的角色                          | **单独字段** `system`，或 `messages` 首条              | 同 OpenAI，放 `messages` 里            |
| max_tokens 字段 | 叫 `max_tokens`（或新版 `max_completion_tokens`） | 叫 `max_tokens`                                 | 叫 `max_tokens`                     |

**对你有影响**：你的 `StreamParams` 里有 `systemPrompt` 单独字段，OpenAI/DeepSeek 需要拼进 `messages`，Anthropic 可以单独传 `system`。

## 2. 消息角色

- **OpenAI / DeepSeek**：`system` / `user` / `assistant` / `tool`
- **Anthropic**：`user` / `assistant`（没有 `system` 角色，但工具结果用 `user` 角色 + `tool_result` content block 传递）

## 3. 流式输出（StreamEvent）差异 —— 你最关心的

你的 `StreamEvent` 是自定义的归一化格式，三家原始格式差别很大：

| 事件 | OpenAI | Anthropic | DeepSeek |
|------|--------|-----------|----------|
| 文本增量 | `choices[0].delta.content` | `content_block_delta` 里的 `text_delta` | 同 OpenAI |
| 工具调用开始 | `delta.tool_calls[0]`（出现一次，带 `id`/`function.name`） | `content_block_start`（带 `tool_use` block） | 同 OpenAI |
| 工具参数增量 | `delta.tool_calls[].function.arguments`（字符串片段） | `input_json_delta`（JSON 片段） | 同 OpenAI |
| 工具调用结束 | `finish_reason: 'tool_calls'` | `content_block_stop` | 同 OpenAI |
| 结束事件 | `finish_reason` + `usage`（`stream_options: {include_usage: true}` 才有） | `message_delta` 里 `stop_reason` + `usage`（自动带） | 同 OpenAI（需 `stream_options`） |

> 注意：**Anthropic 的工具调用是"块结构"**（content blocks），可能多个工具并发出现；OpenAI/DeepSeek 是"增量结构"（tool_calls 数组逐个累积）。

## 4. 停止原因（StopReason）映射

| 你的 StopReason | OpenAI | Anthropic | DeepSeek |
|----------------|--------|-----------|----------|
| `end_turn` | `stop` | `end_turn` | `stop` |
| `tool_use` | `tool_calls` | `tool_use` | `tool_calls` |
| `max_tokens` | `length` | `max_tokens` | `length` |

所以你的 `StopReason` 已经是**跨厂商归一化后的值**，Provider 内部要做映射。

## 5. Token 用量（TokenUsage）

| 维度 | OpenAI | Anthropic | DeepSeek |
|------|--------|-----------|----------|
| 字段名 | `prompt_tokens` / `completion_tokens` / `total_tokens` | `input_tokens` / `output_tokens` | 同 OpenAI |
| 缓存 token | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` / `cache_creation_input_tokens` | 同 OpenAI |

**对你有影响**：你的 `TokenUsage` 用 `inputTokens`/`outputTokens` + `cacheReadTokens`/`cacheWriteTokens`，就是基于 Anthropic 语义定义的，OpenAI/DeepSeek 需要做映射。

## 6. 工具定义（ToolSchema）

- **OpenAI / DeepSeek**：`tools: [{ type: 'function', function: { name, description, parameters } }]`，`parameters` 是 JSON Schema
- **Anthropic**：`tools: [{ name, description, input_schema }]`，直接平铺，没有 `type: 'function'` 包装

你的 `ToolSchema` 有 `id` 字段，但三家 API 的**请求**都不需要传 `id`（`id` 是返回时给的），所以序列化时要剥掉。

## 7. 其他差异

- **认证头**：OpenAI/DeepSeek 用 `Authorization: Bearer <key>`；Anthropic 额外要求 `x-api-key` + `anthropic-version` 头
- **API 兼容性**：DeepSeek 基本是 OpenAI 协议的复刻（还兼容 `chat/completions` 路径），所以实现 OpenAI Provider 时 DeepSeek 可以复用大部分代码
- **流式用法上报**：Anthropic 的 `message_end` 事件里才带 `usage`，OpenAI 默认流式**不带** `usage`，必须开 `stream_options`

---

**给你的架构建议**：你的 `LLMProvider` + `StreamEvent` 归一化设计是合理的。三个 Provider 实现里，**OpenAI 和 DeepSeek 可以共用一个基类**（协议几乎一致，只差 Base URL、模型名、key），Anthropic 单独实现，重点处理 **content block 结构**和 **system 字段**这两个差异点。

需要我帮你基于这个对比，把 `providers/` 目录下的 OpenAI / Anthropic / DeepSeek 三个 Provider 骨架搭出来吗？