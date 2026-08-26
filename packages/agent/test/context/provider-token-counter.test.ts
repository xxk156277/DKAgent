import assert from "node:assert/strict";
import test from "node:test";
import { ProviderTokenCounter, type MessageTokenCounterPort } from "../../src/context/provider-token-counter.js";
import type { AgentMessage, ToolSchema } from "../../src/query-engine/provider.js";

test("计数时把 System Prompt 临时转换成 System 消息", async () => {
    const originalMessages: AgentMessage[] = [{ role: "user", content: "问题" }];
    const tools: ToolSchema[] = [{ name: "read", description: "读取文件", parameters: {} }];
    let receivedMessages: AgentMessage[] = [];
    let receivedTools: ToolSchema[] | undefined;
    const port: MessageTokenCounterPort = {
        async countTokens(messages, inputTools) {
            receivedMessages = messages;
            receivedTools = inputTools;
            return 12;
        },
    };

    const counter = new ProviderTokenCounter(port);
    const result = await counter.count({
        systemPrompt: "系统规则",
        messages: originalMessages,
        tools,
    });

    assert.equal(result, 12);
    assert.deepEqual(receivedMessages, [
        { role: "system", content: "系统规则" },
        { role: "user", content: "问题" },
    ]);
    assert.deepEqual(receivedTools, tools);
    assert.deepEqual(originalMessages, [{ role: "user", content: "问题" }]);
});

test("拒绝 Provider 返回非法 Token 数", async () => {
    const counter = new ProviderTokenCounter({
        countTokens: async () => Number.NaN,
    });

    await assert.rejects(counter.count({ messages: [], tools: [] }), /非法 Token 数/);
});
