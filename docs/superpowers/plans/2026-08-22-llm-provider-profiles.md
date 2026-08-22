# LLM Provider Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DKAgent 默认选择千问配置档，并通过 `LLM_PROVIDER` 一行配置切回 DeepSeek。

**Architecture:** `loadConfig()` 在现有统一 `AgentConfig` 前增加配置档解析，CLI、AgentLoop 和 OpenAI-Compatible Provider 保持不变。显式配置档使用厂商前缀变量；仅为已有 `LLM_*` 配置保留 DeepSeek/旧调用兼容。

**Tech Stack:** TypeScript、Node.js test runner、dotenv、OpenAI-Compatible Chat Completions

## Global Constraints

- 用户明确要求不使用 TDD：先实现，再补行为测试并运行完整验证。
- 默认 Provider 为 `qwen`，默认模型为 `qwen3.7-flash`。
- 千问 Base URL 固定为 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
- DeepSeek 默认模型为 `deepseek-v4-pro`，Base URL 为 `https://api.deepseek.com`。
- 不读取、输出或提交真实 API Key。
- 不修改现有消息、Tool Calling、流式响应或结构化输出协议。

---

### Task 1: 实现 Provider 配置档加载

**Files:**
- Modify: `packages/agent/src/config.ts`
- Create: `packages/agent/test/config/config.test.ts`

**Interfaces:**
- Consumes: `loadConfig(env?: NodeJS.ProcessEnv): AgentConfig`
- Produces: 保持现有 `AgentConfig` 返回结构不变；新增 `LLM_PROVIDER=qwen|deepseek` 选择逻辑。

- [x] **Step 1: 增加配置档常量和解析逻辑**

在 `config.ts` 定义千问与 DeepSeek 的 API Key 变量名、模型变量名、Base URL 变量名及默认值。显式 `qwen` 只读取 `QWEN_*`；显式 `deepseek` 优先读取 `DEEPSEEK_*`，并兼容旧 `LLM_*`。未声明 Provider 但存在 `LLM_API_KEY` 时保持旧通用配置行为，否则默认千问。

- [x] **Step 2: 保持现有 Token 与摘要配置行为**

继续使用 `LLM_CONTEXT_WINDOW_TOKENS`、`LLM_MAX_OUTPUT_TOKENS`、`LLM_SUMMARY_MODEL_ID`，并保持正整数与输出小于上下文窗口的校验。

- [x] **Step 3: 补充配置行为测试**

覆盖默认千问、显式 DeepSeek、DeepSeek 旧变量兼容、未知 Provider、当前配置档缺少 Key，以及既有 Token 校验。

- [x] **Step 4: 运行配置测试**

Run: `npx tsx --test packages/agent/test/config/config.test.ts`

Expected: 全部测试通过，退出码为 0。

### Task 2: 配置本地切换入口和示例

**Files:**
- Create: `.env.example`
- Modify locally, ignored by Git: `.env`

**Interfaces:**
- Consumes: `LLM_PROVIDER` 与厂商前缀变量。
- Produces: 默认 `LLM_PROVIDER=qwen`；改为 `deepseek` 即可复用现有 DeepSeek 配置。

- [x] **Step 1: 新增安全配置示例**

`.env.example` 写入两个配置档的空 Key、默认模型/Base URL，以及 1M 上下文和 20K 最大输出配置，不包含真实密钥。

- [x] **Step 2: 切换本地 `.env` 到千问配置档**

新增 `LLM_PROVIDER=qwen`、空的 `QWEN_API_KEY`、千问模型和 Base URL；保留现有通用 DeepSeek 配置，供 `LLM_PROVIDER=deepseek` 兼容回切。

- [x] **Step 3: 验证缺少千问 Key 时安全失败**

Run: `env -u QWEN_API_KEY LLM_PROVIDER=qwen npx tsx -e 'import { loadConfig } from "./packages/agent/src/config.ts"; loadConfig({ LLM_PROVIDER: "qwen" })'`

Expected: 明确报告缺少 `QWEN_API_KEY`，且不输出其他密钥。

### Task 3: 回归验证

**Files:**
- Verify only: `packages/agent/src/config.ts`
- Verify only: `packages/agent/test/config/config.test.ts`
- Verify only: `.env.example`

**Interfaces:**
- Consumes: 修改后的配置加载器。
- Produces: 现有 CLI 和 Provider 行为无回归的验证证据。

- [x] **Step 1: 运行 Agent 全量测试**

Run: `npm test -w @dkagent/agent`

Expected: 退出码为 0，无失败测试。

- [x] **Step 2: 运行 Agent 类型检查**

Run: `npm run typecheck -w @dkagent/agent`

Expected: 退出码为 0，无 TypeScript 错误。

- [x] **Step 3: 检查变更边界**

Run: `git diff --check && git status --short && git diff -- packages/agent/src/config.ts packages/agent/test/config/config.test.ts .env.example`

Expected: 无空白错误；代码差异只包含本计划文件及设计文档，不包含用户已有删除项或 pnpm 文件。

- [x] **Step 4: 记录真实调用边界**

若本地 `QWEN_API_KEY` 仍为空，不执行网络冒烟并明确标记“未验证真实千问调用”；若存在有效 Key，执行一次最小 Tool Calling 冒烟，且输出中不包含 Key。
