import type {
    AgentMessage,
    LLMProvider,
    ModelRequest,
    StopReason,
    StreamEvent,
    ToolSchema,
} from "../../src/query-engine/provider.js";

export class FakeTextProvider implements LLMProvider {
    public readonly name = "fake";
    public request: ModelRequest | undefined;
    public readonly requests: ModelRequest[] = [];
    private readonly responses: string[];

    public constructor(
        content: string | string[],
        private readonly stopReason: StopReason = "end_turn",
    ) {
        this.responses = Array.isArray(content) ? [...content] : [content];
    }

    public get remainingResponses(): number {
        return this.responses.length;
    }

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        this.request = request;
        this.requests.push(request);
        yield { type: "text_delta", content: this.responses.shift() ?? "" };
        yield {
            type: "message_end",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: this.stopReason,
        };
    }

    public async countTokens(_messages: AgentMessage[], _tools?: ToolSchema[]): Promise<number> {
        return 0;
    }
}
