import assert from "node:assert/strict";
import test from "node:test";
import { MemoryExtractor } from "../../src/memory/extractor.js";
import { AutomaticMemoryWriter } from "../../src/memory/writer.js";
import type {
    MemoryEntry,
    MemoryListOptions,
    MemoryStore,
    MemoryUpsertInput,
} from "../../src/memory/types.js";
import type {
    ModelRequest,
    ModelResponse,
} from "../../src/query-engine/provider.js";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";

class FakeQueryEngine {
    public readonly requests: ModelRequest[] = [];

    public constructor(private readonly response: ModelResponse) {}

    public query(request: ModelRequest): Promise<ModelResponse> {
        this.requests.push(request);
        return Promise.resolve(this.response);
    }
}

class TrackingMemoryStore implements MemoryStore {
    public readonly inputs: MemoryUpsertInput[] = [];

    public constructor(private readonly failKeys = new Set<string>()) {}

    public upsert(input: MemoryUpsertInput): MemoryEntry {
        this.inputs.push(input);
        if (this.failKeys.has(input.key)) {
            throw new Error("写入失败");
        }
        return {
            id: `${input.type}-${input.key}`,
            ...input,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
        };
    }

    public list(_options?: MemoryListOptions): MemoryEntry[] {
        return [];
    }

    public delete(_id: string): boolean {
        return false;
    }
}

function toolResponse(
    name: string,
    input: Record<string, unknown>,
): ModelResponse {
    return {
        type: "tool_use",
        toolCalls: [{ id: "call-1", name, input }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
    };
}

test("Extractor 仅提供固定 Tool Schema，并且 text response 返回空候选", async () => {
    const engine = new FakeQueryEngine({
        type: "text",
        content: "没有长期记忆",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
    });
    const extractor = new MemoryExtractor(engine, "main-model");

    const candidates = await extractor.extract({
        userInput: "今天帮我看一个 bug",
        assistantAnswer: "好的",
        sessionId: "session-1",
    });

    assert.deepEqual(candidates, []);
    assert.equal(engine.requests.length, 1);
    assert.deepEqual(engine.requests[0]?.tools?.map((tool) => tool.name), [
        "submit_memory_candidates",
    ]);
    assert.equal(engine.requests[0]?.maxTokens, 500);
    assert.equal(engine.requests[0]?.temperature, 0);
    assert.equal(engine.requests[0]?.messages.length, 1);
    assert.match(engine.requests[0]?.messages[0]?.content ?? "", /今天帮我看一个 bug/);
    assert.match(engine.requests[0]?.messages[0]?.content ?? "", /好的/);
    assert.match(engine.requests[0]?.systemPrompt ?? "", /临时任务/);
    assert.match(engine.requests[0]?.systemPrompt ?? "", /凭据/);
});

test("Extractor 只解析目标 Tool，并过滤非法、敏感、重复候选且最多保留三条", async () => {
    const engine = new FakeQueryEngine({
        type: "tool_use",
        toolCalls: [
            { id: "other", name: "other_tool", input: { memories: [{ type: "profile", key: "ignored", content: "忽略" }] } },
            {
                id: "target",
                name: "submit_memory_candidates",
                input: {
                    memories: [
                        { type: "preference", key: "answer_style", content: "回答时先讲顶层架构" },
                        { type: "profile", key: "bad key", content: "非法 key" },
                        { type: "decision", key: "api_key", content: "保存 api key" },
                        { type: "preference", key: "answer_style", content: "重复键" },
                        { type: "decision", key: "memory_v1", content: "采用 SQLite" },
                        { type: "profile", key: "target_role", content: "前端 Agent 工程师" },
                        { type: "profile", key: "fourth", content: "第四条有效候选" },
                    ],
                },
            },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
    });

    const candidates = await new MemoryExtractor(engine, "main-model").extract({
        userInput: "以后回答先讲架构",
        assistantAnswer: "好的",
        sessionId: "session-1",
    });

    assert.deepEqual(candidates, [
        { type: "preference", key: "answer_style", content: "回答时先讲顶层架构" },
        { type: "decision", key: "memory_v1", content: "采用 SQLite" },
        { type: "profile", key: "target_role", content: "前端 Agent 工程师" },
    ]);
});

test("Extractor 忽略没有 memories 数组的目标 Tool", async () => {
    const engine = new FakeQueryEngine(toolResponse(
        "submit_memory_candidates",
        { memories: "不是数组" },
    ));

    const candidates = await new MemoryExtractor(engine, "main-model").extract({
        userInput: "你好",
        assistantAnswer: "你好",
        sessionId: "session-1",
    });

    assert.deepEqual(candidates, []);
});

test("Extractor 拒绝含额外字段的候选对象", async () => {
    const engine = new FakeQueryEngine(toolResponse(
        "submit_memory_candidates",
        {
            memories: [{
                type: "preference",
                key: "answer_style",
                content: "回答时先讲顶层架构",
                extra: true,
            }],
        },
    ));

    const candidates = await new MemoryExtractor(engine, "main-model").extract({
        userInput: "以后回答先讲架构",
        assistantAnswer: "好的",
        sessionId: "session-1",
    });

    assert.deepEqual(candidates, []);
});

test("Extractor 仅保留前三条有效候选，并在 Trace 记录其余有效候选为拒绝", async () => {
    const traceStore = new MemoryTraceStore();
    const engine = new FakeQueryEngine(toolResponse(
        "submit_memory_candidates",
        {
            memories: [
                { type: "profile", key: "target_role", content: "前端 Agent 工程师" },
                { type: "preference", key: "answer_style", content: "回答时先讲顶层架构" },
                { type: "decision", key: "memory_v1", content: "采用 SQLite" },
                { type: "profile", key: "location", content: "上海" },
            ],
        },
    ));
    const extractor = new MemoryExtractor(engine, "main-model", new Tracer(traceStore));

    const candidates = await extractor.extract({
        userInput: "记住这些信息",
        assistantAnswer: "好的",
        sessionId: "session-1",
    });

    assert.equal(candidates.length, 3);
    assert.deepEqual(traceStore.list().at(-1)?.data, {
        candidateCount: 3,
        savedCount: 0,
        rejectedCount: 1,
        memories: [
            { type: "profile", key: "target_role" },
            { type: "preference", key: "answer_style" },
            { type: "decision", key: "memory_v1" },
        ],
    });
    assert.doesNotMatch(JSON.stringify(traceStore.list()), /前端 Agent 工程师|顶层架构|采用 SQLite|上海/);
});

test("Writer 写入 automatic 候选并附带 Session ID，单条失败不阻止后续条目", async () => {
    const engine = new FakeQueryEngine(toolResponse(
        "submit_memory_candidates",
        {
            memories: [
                { type: "preference", key: "answer_style", content: "回答时先讲顶层架构" },
                { type: "decision", key: "broken", content: "这条写入会失败" },
                { type: "profile", key: "target_role", content: "前端 Agent 工程师" },
            ],
        },
    ));
    const store = new TrackingMemoryStore(new Set(["broken"]));
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const writer = new AutomaticMemoryWriter(
        new MemoryExtractor(engine, "main-model", tracer),
        store,
        tracer,
    );

    await writer.capture({
        userInput: "以后回答先讲架构",
        assistantAnswer: "好的",
        sessionId: "session-1",
    });

    assert.deepEqual(store.inputs, [
        {
            type: "preference",
            key: "answer_style",
            content: "回答时先讲顶层架构",
            source: "automatic",
            sourceSessionId: "session-1",
        },
        {
            type: "decision",
            key: "broken",
            content: "这条写入会失败",
            source: "automatic",
            sourceSessionId: "session-1",
        },
        {
            type: "profile",
            key: "target_role",
            content: "前端 Agent 工程师",
            source: "automatic",
            sourceSessionId: "session-1",
        },
    ]);
    const writeEvents = traceStore.list().filter((event) => event.name === "memory.write");
    const extractEvents = traceStore.list().filter((event) => event.name === "memory.extract");
    assert.equal(extractEvents.length, 1);
    assert.equal(writeEvents.length, 1);
    assert.deepEqual(writeEvents.at(-1)?.data, {
        candidateCount: 3,
        savedCount: 2,
        rejectedCount: 1,
        memories: [
            { type: "preference", key: "answer_style" },
            { type: "decision", key: "broken" },
            { type: "profile", key: "target_role" },
        ],
    });
    assert.doesNotMatch(JSON.stringify(traceStore.list()), /顶层架构|前端 Agent 工程师|这条写入会失败/);
});
