import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeJson } from "../src/index.js";

test("敏感字段递归脱敏，普通字段和 recalled memory 内容保留", () => {
    const value = sanitizeJson({
        apiKey: "secret",
        nested: { authorization: "Bearer secret", headers: { env: "prod" }, value: "keep" },
        recalled: "<recalled_memory>真实记忆</recalled_memory>",
    });
    assert.deepEqual(value, {
        apiKey: "[REDACTED]",
        nested: { authorization: "[REDACTED]", headers: "[REDACTED]", value: "keep" },
        recalled: "<recalled_memory>真实记忆</recalled_memory>",
    });
});

test("常见 credential key 变体递归脱敏", () => {
    const value = sanitizeJson({
        OPENAI_API_KEY: "a", "x-api-key": "b", token: "c", password: "d", secret: "e",
        ordinary: "keep", recalled: "<recalled_memory>keep</recalled_memory>",
    });
    assert.deepEqual(value, {
        OPENAI_API_KEY: "[REDACTED]", "x-api-key": "[REDACTED]", token: "[REDACTED]",
        password: "[REDACTED]", secret: "[REDACTED]", ordinary: "keep",
        recalled: "<recalled_memory>keep</recalled_memory>",
    });
});

test("token usage 和 context 计数不是 credential key，保留数字", () => {
    const value = sanitizeJson({
        inputTokens: 12,
        outputTokens: 7,
        maxContextTokens: 4096,
        tokensBefore: 100,
        token: "secret",
    });
    assert.deepEqual(value, {
        inputTokens: 12,
        outputTokens: 7,
        maxContextTokens: 4096,
        tokensBefore: 100,
        token: "[REDACTED]",
    });
});
