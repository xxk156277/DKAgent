import assert from "node:assert/strict";
import test from "node:test";
import { groupContextMessages } from "../../src/context/grouper.js";
import type { AgentMessage } from "../../src/query-engine/provider.js";

test("普通消息单独成组，最后一条 User 及之后消息必须保留", () => {
    const messages: AgentMessage[] = [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "当前问题" },
    ];

    const groups = groupContextMessages(messages);

    assert.deepEqual(
        groups.map((group) => group.kind),
        ["single", "single", "single"],
    );
    assert.deepEqual(
        groups.map((group) => group.required),
        [false, false, true],
    );
    assert.deepEqual(messages, [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "当前问题" },
    ]);
});

test("多个 Tool Call 和对应结果形成一个不可拆分组", () => {
    const messages: AgentMessage[] = [
        { role: "user", content: "执行诊断" },
        {
            role: "assistant",
            toolCalls: [
                { id: "call-1", name: "read", input: {} },
                { id: "call-2", name: "parse", input: {} },
            ],
        },
        { role: "tool", toolCallId: "call-1", content: "文件" },
        { role: "tool", toolCallId: "call-2", content: "结果" },
    ];

    const groups = groupContextMessages(messages);

    assert.equal(groups.length, 2);
    assert.equal(groups[1]?.kind, "tool_exchange");
    assert.equal(groups[1]?.messages.length, 3);
    assert.equal(groups[1]?.required, true);
    assert.equal(groups[1]?.estimatedTokens, null);
});

test("拒绝损坏的 Tool 消息链", async (context) => {
    await context.test("孤立 Tool Result", () => {
        assert.throws(
            () => groupContextMessages([{ role: "tool", toolCallId: "call-1", content: "结果" }]),
            /孤立 Tool Result/,
        );
    });

    await context.test("缺少 Tool Result", () => {
        assert.throws(
            () =>
                groupContextMessages([
                    {
                        role: "assistant",
                        toolCalls: [{ id: "call-1", name: "read", input: {} }],
                    },
                ]),
            /缺少对应结果/,
        );
    });

    await context.test("重复 Tool Result", () => {
        assert.throws(
            () =>
                groupContextMessages([
                    {
                        role: "assistant",
                        toolCalls: [{ id: "call-1", name: "read", input: {} }],
                    },
                    { role: "tool", toolCallId: "call-1", content: "第一次" },
                    { role: "tool", toolCallId: "call-1", content: "第二次" },
                ]),
            /重复/,
        );
    });
});
