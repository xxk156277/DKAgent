# LLM Provider 配置档设计

## 目标

DKAgent 默认使用阿里云百炼千问，同时保留 DeepSeek 配置。用户只需修改 `LLM_PROVIDER`，即可在两者之间切换，不需要反复改模型 ID、Base URL 或密钥。

## 配置结构

`.env` 保存实际密钥且不进入 Git：

```dotenv
LLM_PROVIDER=qwen

QWEN_API_KEY=
QWEN_MODEL_ID=qwen3.7-flash
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1

DEEPSEEK_API_KEY=
DEEPSEEK_MODEL_ID=deepseek-v4-pro
DEEPSEEK_BASE_URL=https://api.deepseek.com

LLM_CONTEXT_WINDOW_TOKENS=1000000
LLM_MAX_OUTPUT_TOKENS=20000
```

仓库新增不含密钥的 `.env.example`，作为配置说明。现有 DeepSeek 密钥迁移到 `DEEPSEEK_API_KEY`；百炼密钥由用户填写到 `QWEN_API_KEY`。

## 加载规则

`loadConfig()` 读取 `LLM_PROVIDER` 并选择对应配置档：

- `qwen`：使用 `QWEN_API_KEY`、`QWEN_MODEL_ID`、`QWEN_BASE_URL`。
- `deepseek`：使用 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL_ID`、`DEEPSEEK_BASE_URL`。
- 未配置 `LLM_PROVIDER` 时默认使用 `qwen`。

模型 ID 和 Base URL 提供上述默认值；API Key 不提供默认值。上下文窗口和最大输出 Token 继续使用现有全局配置，避免为两个配置档增加当前不需要的重复项。

## 数据流与边界

启动时，CLI 调用 `loadConfig()` 得到统一的 `AgentConfig`，后续 `OpenAICompatibleProvider`、AgentLoop、摘要模型和 Tool Registry 继续只消费统一配置，不感知具体厂商。

本次不新增 Provider 类，不改变消息、Tool Calling、流式响应或结构化输出协议。千问与 DeepSeek 均继续通过现有 OpenAI-Compatible Provider 调用。

## 错误处理

- `LLM_PROVIDER` 不是 `qwen` 或 `deepseek` 时，启动立即失败并列出允许值。
- 当前配置档缺少 API Key 时，错误信息指出缺少的具体变量，例如 `QWEN_API_KEY`。
- Token 数配置继续沿用现有正整数及大小关系校验。

## 验证

先为配置加载器增加失败测试，再做最小实现：

1. 默认选择千问，并加载千问默认模型与 Base URL。
2. `LLM_PROVIDER=deepseek` 时选择 DeepSeek 配置档。
3. 未知 Provider 明确失败。
4. 当前配置档缺少对应 API Key 明确失败。
5. 运行配置相关测试、Provider 测试、TypeScript 类型检查和 `git diff --check`。

如果用户已配置有效百炼密钥，再执行一次不包含敏感输出的真实 Tool Calling 冒烟验证；没有密钥时不伪称真实调用已通过。
