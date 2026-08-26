import assert from "node:assert/strict";
import test from "node:test";
import type { StreamEvent } from "../../src/query-engine/provider.js";
import { parseModelStream, StreamProtocolError, ToolInputParseError } from "../../src/query-engine/stream-parser.js";

async function* eventsOf(events: StreamEvent[]): AsyncIterable<StreamEvent> {
    for (const event of events) {
        yield event;
    }
}

const usage = {
    inputTokens: 12,
    outputTokens: 4,
};

test("组装文本响应并逐段回调", async () => {
    const deltas: string[] = [];

    const response = await parseModelStream(
        eventsOf([
            { type: "text_delta", content: "你" },
            { type: "text_delta", content: "好" },
            { type: "message_end", usage, stopReason: "end_turn" },
        ]),
        (text) => deltas.push(text),
    );

    assert.deepEqual(deltas, ["你", "好"]);
    assert.deepEqual(response, {
        type: "text",
        content: "你好",
        usage,
        stopReason: "end_turn",
    });
});

test("按 index 组装多个分片 Tool Call", async () => {
    const response = await parseModelStream(
        eventsOf([
            { type: "tool_call_start", index: 1, id: "call-b", name: "tool_b" },
            { type: "tool_call_delta", index: 1, argumentsDelta: '{"b":' },
            { type: "tool_call_start", index: 0, id: "call-a", name: "tool_a" },
            { type: "tool_call_delta", index: 0, argumentsDelta: '{"a":1}' },
            { type: "tool_call_delta", index: 1, argumentsDelta: "2}" },
            { type: "tool_call_end", index: 1 },
            { type: "tool_call_end", index: 0 },
            { type: "message_end", usage, stopReason: "tool_use" },
        ]),
    );

    assert.deepEqual(response, {
        type: "tool_use",
        toolCalls: [
            { id: "call-a", name: "tool_a", input: { a: 1 } },
            { id: "call-b", name: "tool_b", input: { b: 2 } },
        ],
        usage,
        stopReason: "tool_use",
    });
});

test("Tool Delta 没有 Start 时拒绝损坏协议", async () => {
    await assert.rejects(
        parseModelStream(
            eventsOf([
                { type: "tool_call_delta", index: 0, argumentsDelta: "{}" },
                { type: "message_end", usage, stopReason: "tool_use" },
            ]),
        ),
        (error: unknown) => {
            assert.ok(error instanceof StreamProtocolError);
            assert.match(error.message, /index 0.*Start/);
            return true;
        },
    );
});

test("截断的 Tool JSON 提供诊断但不泄露原文", async () => {
    const secret = '{"token":"secret-value"';

    await assert.rejects(
        parseModelStream(
            eventsOf([
                { type: "tool_call_start", index: 0, id: "call-1", name: "read_file" },
                { type: "tool_call_delta", index: 0, argumentsDelta: secret },
                { type: "tool_call_end", index: 0 },
                { type: "message_end", usage, stopReason: "max_tokens" },
            ]),
        ),
        (error: unknown) => {
            assert.ok(error instanceof ToolInputParseError);
            assert.equal(error.toolCallId, "call-1");
            assert.equal(error.toolName, "read_file");
            assert.equal(error.argumentsLength, secret.length);
            assert.equal(error.stopReason, "max_tokens");
            assert.match(error.message, /截断/);
            assert.doesNotMatch(error.message, /secret-value/);
            return true;
        },
    );
});

test("Stream 缺少 Message End 时明确失败", async () => {
    await assert.rejects(parseModelStream(eventsOf([{ type: "text_delta", content: "未完成" }])), (error: unknown) => {
        assert.ok(error instanceof StreamProtocolError);
        assert.match(error.message, /Message End/);
        return true;
    });
});
