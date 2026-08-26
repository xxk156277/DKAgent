import assert from "node:assert/strict";
import test from "node:test";
import type {
    AgentMessage,
    LLMProvider,
    ModelRequest,
    StreamEvent,
    ToolSchema,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";

class FakeProvider implements LLMProvider {
    public readonly name = "fake";
    public request: ModelRequest | undefined;

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        this.request = request;
        yield { type: "text_delta", content: "完成" };
        yield {
            type: "message_end",
            usage: { inputTokens: 3, outputTokens: 1 },
            stopReason: "end_turn",
        };
    }

    public async countTokens(_messages: AgentMessage[], _tools?: ToolSchema[]): Promise<number> {
        return 0;
    }
}

test("QueryEngine 只转发请求并解析 Provider Stream", async () => {
    const provider = new FakeProvider();
    const engine = new QueryEngine(provider);
    const messages: AgentMessage[] = [{ role: "user", content: "开始" }];
    const before = structuredClone(messages);
    const deltas: string[] = [];
    const request: ModelRequest = {
        model: "fake-model",
        messages,
        temperature: 0,
        onTextDelta: (text) => deltas.push(text),
    };

    const response = await engine.query(request);

    assert.equal(provider.request, request);
    assert.deepEqual(messages, before);
    assert.deepEqual(deltas, ["完成"]);
    assert.deepEqual(response, {
        type: "text",
        content: "完成",
        usage: { inputTokens: 3, outputTokens: 1 },
        stopReason: "end_turn",
    });
});
