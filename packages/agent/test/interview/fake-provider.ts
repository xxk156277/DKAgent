import type {
    AgentMessage,
    LLMProvider,
    ModelRequest,
    StreamEvent,
    ToolSchema,
} from "../../src/query-engine/provider.js";

export class FakeTextProvider implements LLMProvider {
    public readonly name = "fake";
    public request: ModelRequest | undefined;

    public constructor(private readonly content: string) {}

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        this.request = request;
        yield { type: "text_delta", content: this.content };
        yield {
            type: "message_end",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
        };
    }

    public async countTokens(
        _messages: AgentMessage[],
        _tools?: ToolSchema[],
    ): Promise<number> {
        return 0;
    }
}
