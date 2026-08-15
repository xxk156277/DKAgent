import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop.js";
import type {
    ContextBuilder,
    ContextBuildInput,
    ContextSnapshot,
    ConversationContextState,
} from "../../src/context/types.js";
import type {
    AgentMessage,
    LLMProvider,
    StreamEvent,
    StreamParams,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import type {
    SessionSnapshot,
    SessionStore,
    SessionSummary,
} from "../../src/session/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

class FakeProvider implements LLMProvider {
    public readonly name = "fake";
    public readonly requests: StreamParams[] = [];

    public constructor(private readonly responses: StreamEvent[][]) { }

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        const response = this.responses.shift();
        if (!response) throw new Error("FakeProvider 没有可用响应");
        for (const event of response) yield event;
    }

    public async countTokens(): Promise<number> {
        return 0;
    }
}

class RecordingSessionStore implements SessionStore {
    public readonly appendedMessages: AgentMessage[] = [];
    /** 记录每次追加消息写入的目标 Session ID。 */
    public readonly appendedSessionIds: string[] = [];
    public readonly savedStates: ConversationContextState[] = [];

    public constructor(public readonly snapshot: SessionSnapshot) { }

    public create(): SessionSnapshot {
        return this.snapshot;
    }

    public loadLatest(): SessionSnapshot {
        return this.snapshot;
    }

    public list(): SessionSummary[] {
        return [{
            id: this.snapshot.id,
            createdAt: this.snapshot.createdAt,
            updatedAt: this.snapshot.updatedAt,
        }];
    }

    public load(sessionId: string): SessionSnapshot | null {
        return sessionId === this.snapshot.id ? this.snapshot : null;
    }

    public delete(sessionId: string): boolean {
        return sessionId === this.snapshot.id;
    }

    public appendMessage(sessionId: string, message: AgentMessage): void {
        this.appendedSessionIds.push(sessionId);
        this.appendedMessages.push(structuredClone(message));
    }

    public saveContextState(
        _sessionId: string,
        state: ConversationContextState,
    ): void {
        this.savedStates.push({ ...state });
    }
}

const passthroughContextBuilder: ContextBuilder = {
    async build(input: ContextBuildInput): Promise<ContextSnapshot> {
        return {
            messages: [...input.messages],
            tools: [...input.tools],
        };
    },
};

const usage = { inputTokens: 1, outputTokens: 1 };

function textResponse(content: string): StreamEvent[] {
    return [
        { type: "text_delta", content },
        { type: "message_end", usage, stopReason: "end_turn" },
    ];
}

function emptySnapshot(id: string): SessionSnapshot {
    const timestamp = "2026-08-14T00:00:00.000Z";
    return {
        id,
        messages: [],
        contextState: {
            summary: "",
            firstKeptMessageIndex: 0,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
    };
}

function createSessionAgent(
    provider: FakeProvider,
    store: RecordingSessionStore,
    contextManager: ContextBuilder = passthroughContextBuilder,
): AgentLoop {
    return new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: new ToolRegistry(),
        contextManager,
        model: "fake-model",
        maxContextTokens: 1_000,
        maxOutputTokens: 100,
        session: {
            snapshot: store.snapshot,
            store,
        },
    });
}

test("AgentLoop 从 SessionSnapshot 恢复历史并继续对话", async () => {
    const store = new RecordingSessionStore({
        id: "session-1",
        messages: [
            { role: "user", content: "旧问题" },
            { role: "assistant", content: "旧回答" },
        ],
        contextState: {
            summary: "旧摘要",
            firstKeptMessageIndex: 1,
        },
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
    });
    const provider = new FakeProvider([textResponse("新回答")]);
    const agent = createSessionAgent(provider, store);

    await agent.run("新问题");

    assert.deepEqual(provider.requests[0]?.messages, [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "新问题" },
    ]);
    assert.deepEqual(store.appendedMessages, [
        { role: "user", content: "新问题" },
        { role: "assistant", content: "新回答" },
    ]);
    assert.deepEqual(store.appendedSessionIds, ["session-1", "session-1"]);
    assert.deepEqual(agent.getContextState(), {
        summary: "旧摘要",
        firstKeptMessageIndex: 1,
    });
});

test("AgentLoop 保存 ContextManager 返回的新压缩状态", async () => {
    const store = new RecordingSessionStore(emptySnapshot("session-2"));
    const nextState = {
        summary: "新摘要",
        firstKeptMessageIndex: 2,
    };
    const contextBuilder: ContextBuilder = {
        async build(input): Promise<ContextSnapshot> {
            return {
                messages: [...input.messages],
                tools: [...input.tools],
                nextContextState: nextState,
            };
        },
    };
    const agent = createSessionAgent(
        new FakeProvider([textResponse("回答")]),
        store,
        contextBuilder,
    );

    await agent.run("问题");

    assert.deepEqual(store.savedStates, [nextState]);
    assert.deepEqual(agent.getContextState(), nextState);
});
