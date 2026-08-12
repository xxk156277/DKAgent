import assert from "node:assert/strict";
import test from "node:test";
import { ContextManager } from "../../src/context/manager.js";
import type {
    ContextTokenCountInput,
    ContextTokenCounter,
} from "../../src/context/types.js";
import type { AgentMessage } from "../../src/query-engine/provider.js";

class DeterministicTokenCounter implements ContextTokenCounter {
    public count(input: ContextTokenCountInput): Promise<number> {
        const systemTokens = input.systemPrompt === undefined ? 0 : 1;
        return Promise.resolve(
            systemTokens + input.messages.length + input.tools.length,
        );
    }
}

test("未超预算时保留完整历史且不修改输入", async () => {
    const messages: AgentMessage[] = [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
    ];
    const original = structuredClone(messages);
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        systemPrompt: "系统规则",
        messages,
        tools: [],
        maxContextTokens: 10,
        reservedOutputTokens: 2,
    });

    assert.deepEqual(snapshot.messages, messages);
    assert.equal(snapshot.estimatedInputTokens, 3);
    assert.equal(snapshot.droppedMessageCount, 0);
    assert.deepEqual(messages, original);
    assert.notEqual(snapshot.messages, messages);
});

test("超预算时从最旧的非必留消息组开始删除", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        messages: [
            { role: "user", content: "旧问题" },
            { role: "assistant", content: "旧回答" },
            { role: "user", content: "当前问题" },
        ],
        tools: [],
        maxContextTokens: 3,
        reservedOutputTokens: 1,
    });

    assert.deepEqual(snapshot.messages, [
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "当前问题" },
    ]);
    assert.equal(snapshot.droppedMessageCount, 1);
});

test("裁剪时完整删除 Tool Call 和 Tool Result", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    const snapshot = await manager.build({
        messages: [
            { role: "user", content: "旧问题" },
            {
                role: "assistant",
                toolCalls: [{ id: "call-1", name: "read", input: {} }],
            },
            { role: "tool", toolCallId: "call-1", content: "结果" },
            { role: "user", content: "当前问题" },
        ],
        tools: [],
        maxContextTokens: 2,
        reservedOutputTokens: 1,
    });

    assert.deepEqual(snapshot.messages, [
        { role: "user", content: "当前问题" },
    ]);
    assert.equal(snapshot.droppedMessageCount, 3);
});

test("必留内容超过预算时明确失败", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    await assert.rejects(
        manager.build({
            systemPrompt: "系统规则",
            messages: [{ role: "user", content: "当前问题" }],
            tools: [],
            maxContextTokens: 2,
            reservedOutputTokens: 1,
        }),
        /必留上下文超过可用 Token 预算/,
    );
});

test("拒绝非法 Token 预算", async () => {
    const manager = new ContextManager(new DeterministicTokenCounter());

    await assert.rejects(
        manager.build({
            messages: [],
            tools: [],
            maxContextTokens: 0,
            reservedOutputTokens: 0,
        }),
        /maxContextTokens 必须是正整数/,
    );
});
