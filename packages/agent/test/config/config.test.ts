import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../src/config.js";

test("未配置 Provider 时默认加载千问配置档", () => {
    const config = loadConfig({ QWEN_API_KEY: "qwen-key" });

    assert.equal(config.apiKey, "qwen-key");
    assert.equal(config.model, "qwen3.7-flash");
    assert.equal(config.baseURL, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(config.summaryModel, "qwen3.7-flash");
});

test("显式选择 DeepSeek 时加载对应配置档", () => {
    const config = loadConfig({
        LLM_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "deepseek-key",
        DEEPSEEK_MODEL_ID: "deepseek-test",
        DEEPSEEK_BASE_URL: "https://deepseek.example/v1",
    });

    assert.equal(config.apiKey, "deepseek-key");
    assert.equal(config.model, "deepseek-test");
    assert.equal(config.baseURL, "https://deepseek.example/v1");
});

test("新 DeepSeek 配置档不混用旧通用模型配置", () => {
    const config = loadConfig({
        LLM_PROVIDER: "deepseek",
        DEEPSEEK_API_KEY: "deepseek-key",
        LLM_MODEL_ID: "legacy-model",
        LLM_BASE_URL: "https://legacy.example/v1",
    });

    assert.equal(config.model, "deepseek-v4-pro");
    assert.equal(config.baseURL, "https://api.deepseek.com");
});

test("显式选择 DeepSeek 时兼容旧 LLM 配置", () => {
    const config = loadConfig({
        LLM_PROVIDER: "deepseek",
        LLM_API_KEY: "legacy-key",
        LLM_MODEL_ID: "legacy-model",
        LLM_BASE_URL: "https://legacy.example/v1",
    });

    assert.equal(config.apiKey, "legacy-key");
    assert.equal(config.model, "legacy-model");
    assert.equal(config.baseURL, "https://legacy.example/v1");
});

test("未声明 Provider 的旧 LLM 配置保持原行为", () => {
    const config = loadConfig({
        LLM_API_KEY: "legacy-key",
        LLM_MODEL_ID: "legacy-model",
        LLM_BASE_URL: "https://legacy.example/v1",
    });

    assert.equal(config.apiKey, "legacy-key");
    assert.equal(config.model, "legacy-model");
    assert.equal(config.baseURL, "https://legacy.example/v1");
});

test("拒绝未知 Provider", () => {
    assert.throws(() => loadConfig({ LLM_PROVIDER: "unknown" }), /LLM_PROVIDER 必须是 qwen 或 deepseek/);
});

test("缺少当前千问配置档的 API Key 时明确失败", () => {
    assert.throws(() => loadConfig({ LLM_PROVIDER: "qwen" }), /缺少环境变量 QWEN_API_KEY/);
});

test("继续校验最大输出 Token 必须小于上下文窗口", () => {
    assert.throws(
        () =>
            loadConfig({
                QWEN_API_KEY: "qwen-key",
                LLM_CONTEXT_WINDOW_TOKENS: "100",
                LLM_MAX_OUTPUT_TOKENS: "100",
            }),
        /LLM_MAX_OUTPUT_TOKENS 必须小于 LLM_CONTEXT_WINDOW_TOKENS/,
    );
});

test("RAG 默认关闭，关闭时不要求 Embedding 配置", () => {
    const config = loadConfig({ QWEN_API_KEY: "qwen-key" });

    assert.equal(config.rag, undefined);
});

test("RAG 启用时加载检索配置", () => {
    const config = loadConfig({
        QWEN_API_KEY: "qwen-key",
        RAG_ENABLED: "true",
        SILICONFLOW_API_KEY: "embedding-key",
        DATABASE_URL: "postgresql://rag:test@localhost:5439/rag",
        EMBEDDING_BASE_URL: "https://embedding.example/v1",
        EMBEDDING_MODEL: "BAAI/bge-m3",
    });

    assert.deepEqual(config.rag, {
        databaseUrl: "postgresql://rag:test@localhost:5439/rag",
        embedding: {
            apiKey: "embedding-key",
            baseUrl: "https://embedding.example/v1",
            model: "BAAI/bge-m3",
            dimensions: 1024,
        },
    });
});

test("RAG 启用但缺少 Embedding Key 时明确失败", () => {
    assert.throws(
        () => loadConfig({ QWEN_API_KEY: "qwen-key", RAG_ENABLED: "true" }),
        /缺少环境变量 SILICONFLOW_API_KEY/,
    );
});
