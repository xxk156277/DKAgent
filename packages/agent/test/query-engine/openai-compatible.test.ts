import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage, ToolSchema } from "../../src/query-engine/provider.js";
import type { ModelRequest } from "../../src/query-engine/provider.js";
import {
    OpenAICompatibleProvider,
    toOpenAIMessages,
    toOpenAIResponseFormat,
    toOpenAITools,
    translateOpenAIChunks,
    type OpenAIStreamChunk,
} from "../../src/query-engine/providers/openai-compatible.js";

test("转换 DeepSeek JSON Output 格式且普通文本请求保持省略", () => {
    assert.deepEqual(toOpenAIResponseFormat("json_object"), {
        type: "json_object",
    });
    assert.equal(toOpenAIResponseFormat(undefined), undefined);
});

test("将禁用思考映射为 DeepSeek thinking 请求字段", async () => {
    const capturedRequest = await captureOpenAIRequest({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "只输出 JSON" }],
        thinking: "disabled",
    });

    assert.deepEqual(capturedRequest.thinking, { type: "disabled" });
});

test("普通 OpenAI 模型不发送 DeepSeek thinking 字段", async () => {
    const capturedRequest = await captureOpenAIRequest({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "只输出 JSON" }],
        thinking: "disabled",
    });

    assert.equal("thinking" in capturedRequest, false);
});

async function* chunksOf(chunks: OpenAIStreamChunk[]): AsyncIterable<OpenAIStreamChunk> {
    for (const chunk of chunks) {
        yield chunk;
    }
}

async function captureOpenAIRequest(request: ModelRequest): Promise<Record<string, unknown>> {
    const provider = new OpenAICompatibleProvider("test-key");
    let capturedRequest: Record<string, unknown> | undefined;
    const client = provider as unknown as {
        client: {
            chat: {
                completions: {
                    create(input: Record<string, unknown>): Promise<AsyncIterable<OpenAIStreamChunk>>;
                };
            };
        };
    };
    client.client.chat.completions.create = async (input) => {
        capturedRequest = input;
        return chunksOf([
            {
                choices: [],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
        ]);
    };

    for await (const _event of provider.stream(request)) {
        // 消费完整流，确保请求已发给兼容 API。
    }
    assert.ok(capturedRequest);
    return capturedRequest;
}

test("转换通用消息且不修改输入", () => {
    const messages: AgentMessage[] = [
        { role: "user", content: "分析文件" },
        {
            role: "assistant",
            content: "准备读取",
            toolCalls: [{ id: "call-1", name: "read_file", input: { path: "a.md" } }],
        },
        { role: "tool", toolCallId: "call-1", content: "文件内容" },
    ];
    const before = structuredClone(messages);

    const result = toOpenAIMessages(messages, "系统规则");

    assert.deepEqual(messages, before);
    assert.deepEqual(result, [
        { role: "system", content: "系统规则" },
        { role: "user", content: "分析文件" },
        {
            role: "assistant",
            content: "准备读取",
            tool_calls: [
                {
                    id: "call-1",
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: '{"path":"a.md"}',
                    },
                },
            ],
        },
        { role: "tool", tool_call_id: "call-1", content: "文件内容" },
    ]);
});

test("转换 Tool Schema", () => {
    const tools: ToolSchema[] = [
        {
            name: "read_file",
            description: "读取文件",
            parameters: {
                type: "object",
                properties: { path: { type: "string" } },
            },
        },
    ];

    assert.deepEqual(toOpenAITools(tools), [
        {
            type: "function",
            function: {
                name: "read_file",
                description: "读取文件",
                parameters: tools[0]!.parameters,
            },
        },
    ]);
});

test("将多个 OpenAI Tool Chunk 转为带 index 的统一事件和真实 Usage", async () => {
    const events = [];

    for await (const event of translateOpenAIChunks(
        chunksOf([
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id: "call-a",
                                    function: { name: "tool_a", arguments: '{"a":' },
                                },
                                {
                                    index: 1,
                                    id: "call-b",
                                    function: { name: "tool_b", arguments: '{"b":2}' },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ],
            },
            {
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, function: { arguments: "1}" } }],
                        },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            {
                choices: [],
                usage: {
                    prompt_tokens: 21,
                    completion_tokens: 7,
                    prompt_tokens_details: { cached_tokens: 5 },
                },
            },
        ]),
    )) {
        events.push(event);
    }

    assert.deepEqual(events, [
        { type: "tool_call_start", index: 0, id: "call-a", name: "tool_a" },
        { type: "tool_call_delta", index: 0, argumentsDelta: '{"a":' },
        { type: "tool_call_start", index: 1, id: "call-b", name: "tool_b" },
        { type: "tool_call_delta", index: 1, argumentsDelta: '{"b":2}' },
        { type: "tool_call_delta", index: 0, argumentsDelta: "1}" },
        { type: "tool_call_end", index: 0 },
        { type: "tool_call_end", index: 1 },
        {
            type: "message_end",
            usage: { inputTokens: 21, outputTokens: 7, cacheReadTokens: 5 },
            stopReason: "tool_use",
        },
    ]);
});
