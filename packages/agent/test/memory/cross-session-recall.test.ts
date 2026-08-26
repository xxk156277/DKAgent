import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentLoop } from "../../src/agent/loop.js";
import { ContextManager, ProviderTokenCounter } from "../../src/context/index.js";
import { MemoryRetriever } from "../../src/memory/retriever.js";
import { SqliteMemoryStore } from "../../src/memory/store.js";
import type {
    AgentMessage,
    LLMProvider,
    StreamEvent,
    StreamParams,
    ToolSchema,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { SqliteSessionStore } from "../../src/session/store.js";
import { ToolRegistry } from "../../src/tools/registry.js";

class FakeProvider implements LLMProvider {
    public readonly name = "fake";
    public readonly requests: StreamParams[] = [];

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        yield { type: "text_delta", content: "已读取历史上下文" };
        yield {
            type: "message_end",
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: "end_turn",
        };
    }

    public async countTokens(messages: AgentMessage[], _tools?: ToolSchema[]): Promise<number> {
        return messages.reduce(
            (total, message) => total + ("content" in message ? (message.content?.length ?? 0) : 0),
            0,
        );
    }
}

test("SQLite Memory 跨进程重开后在新 Session 只注入请求 Context", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-memory-vertical-"));
    const memoryPath = join(directory, "memory.db");
    const sessionPath = join(directory, "sessions.db");
    const fact = "用户的稳定偏好是先讲顶层架构";

    const firstMemoryStore = new SqliteMemoryStore(memoryPath);
    const firstSessionStore = new SqliteSessionStore(sessionPath);
    try {
        const sessionA = firstSessionStore.create();
        firstMemoryStore.upsert({
            type: "preference",
            key: "answer_style",
            content: fact,
            source: "explicit",
            sourceSessionId: sessionA.id,
        });
    } finally {
        firstMemoryStore.close();
        firstSessionStore.close();
    }

    const memoryStore = new SqliteMemoryStore(memoryPath);
    const sessionStore = new SqliteSessionStore(sessionPath);
    try {
        const sessionB = sessionStore.create();
        const provider = new FakeProvider();
        const agent = new AgentLoop({
            queryEngine: new QueryEngine(provider),
            toolRegistry: new ToolRegistry(),
            contextManager: new ContextManager(new ProviderTokenCounter(provider)),
            model: "fake-model",
            maxContextTokens: 2_000,
            maxOutputTokens: 100,
            systemPrompt: "固定系统规则",
            memoryReader: new MemoryRetriever(memoryStore),
            session: {
                snapshot: sessionB,
                store: sessionStore,
            },
        });

        assert.equal(await agent.run("请回答当前问题"), "已读取历史上下文");
        assert.match(provider.requests[0]?.systemPrompt ?? "", new RegExp(fact));
        assert.match(provider.requests[0]?.systemPrompt ?? "", /<recalled_memory>/);
        assert.doesNotMatch(JSON.stringify(agent.getMessages()), new RegExp(fact));
        assert.doesNotMatch(JSON.stringify(sessionStore.load(sessionB.id)), new RegExp(fact));
    } finally {
        memoryStore.close();
        sessionStore.close();
    }
});
