import type { TraceEvent, TraceEventName, TracePhase } from "@dkagent/trace";
import { describe, expect, it } from "vitest";
import { createContextDiff } from "../../src/web/model/context-diff.js";
import { moduleForEvent, moduleForTraceEvent, projectEvents } from "../../src/web/model/project-events.js";

const request = {
    model: "test-model",
    messages: [{ role: "user", content: "你好" }],
    tools: [],
};
const textResponse = {
    type: "text",
    content: "你好",
    usage: { inputTokens: 4, outputTokens: 2 },
    stopReason: "end_turn",
};
const beforePayload = {
    messages: [{ role: "user", content: "你好" }],
    maxContextTokens: 100,
    reservedOutputTokens: 20,
};
const afterPayload = {
    messages: [{ role: "user", content: "你好" }],
    estimatedInputTokens: 4,
    availableInputTokens: 80,
    droppedMessageCount: 0,
};

function event(type: string, turnId: string, payload: unknown, step?: number, sessionId = "session-1"): TraceEvent {
    const mapped = legacyEvent(type, payload);
    return {
        id: `event-${turnId}-${type}-${step ?? 0}`,
        sessionId,
        traceId: turnId,
        sequence: (sequence += 1),
        timestamp: "2026-08-12T00:00:00.000Z",
        name: mapped.name,
        phase: mapped.phase,
        data: mapped.data,
        ...(step === undefined ? {} : { step }),
    };
}

function trace(
    id: string,
    name: TraceEventName,
    phase: TracePhase,
    data: unknown,
    module: NonNullable<TraceEvent["module"]>,
    operation: string,
): TraceEvent {
    return {
        id,
        traceId: "turn-memory-skill",
        sequence: (sequence += 1),
        timestamp: "2026-08-18T00:00:00.000Z",
        name,
        phase,
        data,
        module,
        operation,
    };
}

function legacyEvent(
    type: string,
    payload: unknown,
): {
    name: TraceEventName;
    phase: TracePhase;
    data: unknown;
} {
    switch (type) {
        case "turn.start":
            return { name: "agent.turn", phase: "start", data: { input: payload } };
        case "turn.end":
            return { name: "agent.turn", phase: "end", data: { output: payload } };
        case "context.before":
            return { name: "context.build", phase: "start", data: { input: payload } };
        case "context.after":
            return {
                name: "context.snapshot.created",
                phase: "event",
                data: {
                    context: payload,
                    metrics: { droppedMessageCount: isRecord(payload) ? (payload.droppedMessageCount ?? 0) : 0 },
                },
            };
        case "model.response":
            return { name: "model.response", phase: "event", data: payload };
        case "tool.call":
            return { name: "tool.call", phase: "start", data: { input: payload } };
        case "tool.result":
            return { name: "tool.result", phase: "event", data: payload };
        default:
            return { name: type as TraceEventName, phase: "event", data: payload };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

let sequence = 0;

describe("projectEvents", () => {
    it("maps current and future trace prefixes to Tap modules", () => {
        expect(
            [
                "session.opened",
                "context.build",
                "memory.recall",
                "skill.loaded",
                "tool.call",
                "model.request",
                "agent.turn",
                "custom.trace",
            ].map(moduleForEvent),
        ).toEqual(["session", "context", "memory", "skill", "tool", "model", "agent", "other"]);
    });

    it("projects Memory, Skill and internal model events with their explicit modules", () => {
        sequence = 0;
        const events: TraceEvent[] = [
            trace(
                "memory-recall-start",
                "memory.recall",
                "start",
                { input: { userInputCharacterCount: 4 } },
                "memory",
                "recall",
            ),
            trace("memory-recall-end", "memory.recall", "end", { output: { characterCount: 12 } }, "memory", "recall"),
            trace(
                "memory-extract-error",
                "memory.extract",
                "error",
                { error: { message: "提取失败" } },
                "memory",
                "extract",
            ),
            trace("memory-write-event", "memory.write", "event", { savedCount: 1 }, "memory", "write"),
            trace("skill-run-start", "skill.run", "start", { input: { turnCount: 2 } }, "skill", "diagnose-transcript"),
            trace(
                "skill-stage-error",
                "skill.stage",
                "error",
                { error: { message: "分析失败" } },
                "skill",
                "analyze_answer",
            ),
            trace(
                "skill-model-request",
                "model.request",
                "start",
                { input: { model: "skill-model" } },
                "skill",
                "analyze_answer",
            ),
            trace("skill-model-response", "model.response", "event", { content: "完成" }, "skill", "analyze_answer"),
            trace(
                "memory-model-request",
                "model.request",
                "start",
                { input: { model: "memory-model" } },
                "memory",
                "extract",
            ),
            trace("memory-model-response", "model.response", "event", { content: "完成" }, "memory", "extract"),
        ];

        const nodes = projectEvents(events)[0]?.turns[0]?.steps[0]?.nodes ?? [];

        expect(nodes.map((node) => node.kind)).not.toContain("unknown");
        expect(nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "memory_operation", module: "memory", title: "召回记忆" }),
                expect.objectContaining({ kind: "memory_operation", module: "memory", title: "召回记忆完成" }),
                expect.objectContaining({
                    kind: "memory_operation",
                    module: "memory",
                    title: "提取记忆失败",
                    status: "error",
                }),
                expect.objectContaining({ kind: "memory_operation", module: "memory", title: "写入记忆结果" }),
                expect.objectContaining({ kind: "skill_operation", module: "skill", title: "分析面试记录" }),
                expect.objectContaining({
                    kind: "skill_operation",
                    module: "skill",
                    title: "分析回答失败",
                    status: "error",
                }),
                expect.objectContaining({ kind: "model_request", module: "skill", title: "分析回答 · 模型请求" }),
                expect.objectContaining({ kind: "model_response", module: "skill", title: "分析回答 · 模型响应" }),
                expect.objectContaining({ kind: "model_request", module: "memory", title: "提取记忆 · 模型请求" }),
                expect.objectContaining({ kind: "model_response", module: "memory", title: "提取记忆 · 模型响应" }),
            ]),
        );
        expect(moduleForTraceEvent(events[6]!)).toBe("skill");
    });

    it("projects Artifact create and resolve events with Chinese labels", () => {
        sequence = 0;
        const events: TraceEvent[] = [
            trace(
                "artifact-created",
                "artifact.created",
                "event",
                { artifactId: "artifact-1", artifactType: "file_text" },
                "artifact",
                "read_file",
            ),
            trace(
                "artifact-resolved",
                "artifact.resolved",
                "event",
                { artifactId: "artifact-1", artifactType: "file_text", hit: true },
                "artifact",
                "parse_transcript",
            ),
            trace(
                "artifact-missed",
                "artifact.resolved",
                "event",
                { artifactId: "missing", artifactType: "file_text", hit: false },
                "artifact",
                "parse_transcript",
            ),
        ];

        const nodes = projectEvents(events)[0]?.turns[0]?.steps[0]?.nodes ?? [];

        expect(nodes.map((node) => node.kind)).toEqual([
            "artifact_operation",
            "artifact_operation",
            "artifact_operation",
        ]);
        expect(nodes.map((node) => node.title)).toEqual(["创建产物", "读取产物", "读取产物失败"]);
        expect(nodes.map((node) => node.status)).toEqual(["completed", "completed", "error"]);
        expect(nodes.every((node) => node.module === "artifact")).toBe(true);
    });

    it("按 sessionId 分组且未关联事件进入 unlinked 观察组", () => {
        sequence = 0;
        const sessionA = event("turn.start", "turn-a", { input: "A" }, 1, "session-a");
        const sessionB = event("turn.start", "turn-b", { input: "B" }, 1, "session-b");
        const { sessionId: _sessionId, ...unlinked } = event("turn.start", "turn-old", { input: "旧" });

        const sessions = projectEvents([sessionA, sessionB, unlinked]);

        expect(sessions.map((session) => session.id)).toEqual(["session-a", "session-b", "unlinked"]);
        expect(sessions.map((session) => session.turns[0]?.id)).toEqual(["turn-a", "turn-b", "turn-old"]);
    });

    it("keeps every source event once on its Turn projection", () => {
        sequence = 0;
        const events = [
            event("turn.start", "turn-events", { input: "你好" }),
            event("context.before", "turn-events", beforePayload, 1),
            event("context.after", "turn-events", afterPayload, 1),
            event("model.response", "turn-events", { request, response: textResponse }, 1),
            event("turn.end", "turn-events", { answer: "你好" }, 1),
        ];

        const turn = projectEvents(events)[0]?.turns[0];

        expect(turn?.rawEvents).toEqual(events);
    });

    it("projects one text Turn into one Step with adjacent model nodes", () => {
        sequence = 0;
        const textTurn = [
            event("turn.start", "turn-1", { input: "你好" }),
            event("context.before", "turn-1", beforePayload, 1),
            event("context.after", "turn-1", afterPayload, 1),
            event("model.response", "turn-1", { request, response: textResponse }, 1),
            event("turn.end", "turn-1", { answer: "你好" }, 1),
        ];

        const sessions = projectEvents(textTurn);

        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.turns).toHaveLength(1);
        const step = sessions[0]?.turns[0]?.steps[0];
        expect(step?.step).toBe(1);
        expect(step?.nodes.map((node) => node.kind)).toEqual([
            "turn_start",
            "context_before",
            "context_after",
            "model_request",
            "model_response",
            "turn_end",
        ]);
        expect(step?.nodes.map((node) => node.module)).toEqual([
            "agent",
            "context",
            "context",
            "model",
            "model",
            "agent",
        ]);
        expect(step?.nodes[3]?.id).toContain("turn-1:1:model_request");
        expect(step?.nodes[4]?.id).toContain("turn-1:1:model_response");
    });

    it("projects Tool Call and Result in Step 1, then model nodes in Step 2", () => {
        sequence = 0;
        const toolTurn = [
            event("turn.start", "turn-tool", { input: "帮我查" }),
            event("context.before", "turn-tool", beforePayload, 1),
            event("context.after", "turn-tool", afterPayload, 1),
            event(
                "model.response",
                "turn-tool",
                {
                    request,
                    response: {
                        type: "tool_use",
                        toolCalls: [{ id: "call-1", name: "search", input: { q: "DKAgent" } }],
                        usage: { inputTokens: 4, outputTokens: 2 },
                        stopReason: "tool_use",
                    },
                },
                1,
            ),
            event("tool.call", "turn-tool", { id: "call-1", name: "search", input: { q: "DKAgent" } }, 1),
            event("tool.result", "turn-tool", { toolCallId: "call-1", name: "search", result: { success: true } }, 1),
            event("context.before", "turn-tool", beforePayload, 2),
            event("context.after", "turn-tool", afterPayload, 2),
            event("model.response", "turn-tool", { request, response: textResponse }, 2),
            event("turn.end", "turn-tool", { answer: "结果" }, 2),
        ];

        const turn = projectEvents(toolTurn)[0]?.turns[0];

        expect(turn?.steps.map((step) => step.step)).toEqual([1, 2]);
        expect(turn?.steps[0]?.nodes.map((node) => node.kind)).toContain("tool_call");
        expect(turn?.steps[0]?.nodes.map((node) => node.kind)).toContain("tool_result");
        expect(turn?.steps[0]?.nodes.find((node) => node.kind === "tool_call")?.module).toBe("tool");
        expect(turn?.steps[0]?.nodes.find((node) => node.kind === "tool_result")?.module).toBe("tool");
        expect(turn?.steps[1]?.nodes.map((node) => node.kind)).toEqual([
            "context_before",
            "context_after",
            "model_request",
            "model_response",
            "turn_end",
        ]);
    });

    it("renders unknown events and direct context trim without mutating input events", () => {
        sequence = 0;
        const events = [
            event("turn.start", "turn-trim", { input: "你好" }),
            event("context.before", "turn-trim", beforePayload, 1),
            event("context.after", "turn-trim", { ...afterPayload, droppedMessageCount: 1 }, 1),
            {
                ...event("turn.end", "turn-trim", { answer: "你好" }, 1),
                name: "custom.trace" as TraceEventName,
                phase: "event" as const,
            },
        ];
        const original = structuredClone(events);

        const nodes = projectEvents(events)[0]?.turns[0]?.steps[0]?.nodes;

        expect(nodes?.map((node) => node.kind)).toEqual([
            "turn_start",
            "context_before",
            "context_trimmed",
            "context_after",
            "unknown",
        ]);
        expect(nodes?.[2]?.rawEvents).toHaveLength(2);
        expect(nodes?.[4]?.detail).toEqual({ raw: events[3] });
        expect(events).toEqual(original);
    });
});

describe("createContextDiff", () => {
    it("removes matched Tool Calls and Tool Results as one group", () => {
        const toolCall = { id: "call-1", name: "search", input: { q: "DKAgent" } };
        const before = {
            messages: [
                { role: "user", content: "旧问题" },
                { role: "assistant", toolCalls: [toolCall] },
                { role: "tool", toolCallId: "call-1", content: '{"success":true}' },
                { role: "user", content: "新问题" },
            ],
            estimatedInputTokens: 20,
            availableInputTokens: 80,
            maxContextTokens: 100,
            reservedOutputTokens: 20,
        };
        const after = {
            messages: [{ role: "user", content: "新问题" }],
            estimatedInputTokens: 5,
            availableInputTokens: 80,
        };

        const diff = createContextDiff(before, after);

        expect(diff.beforeMessageCount).toBe(4);
        expect(diff.afterMessageCount).toBe(1);
        expect(diff.beforeEstimatedInputTokens).toBe(20);
        expect(diff.afterEstimatedInputTokens).toBe(5);
        expect(diff.beforeMaxContextTokens).toBe(100);
        expect(diff.beforeReservedOutputTokens).toBe(20);
        expect(diff.afterAvailableInputTokens).toBe(80);
        expect(diff.removedGroups.map((group) => group.messages.length)).toEqual([1, 2]);
    });

    it("keeps an incomplete Tool exchange together when it is removed", () => {
        const before = {
            messages: [
                {
                    role: "assistant",
                    toolCalls: [
                        { id: "call-1", name: "first", input: {} },
                        { id: "call-2", name: "second", input: {} },
                    ],
                },
                { role: "tool", toolCallId: "call-1", content: "partial result" },
                { role: "user", content: "继续" },
            ],
        };
        const after = { messages: [{ role: "user", content: "继续" }] };

        const diff = createContextDiff(before, after);

        expect(diff.removedGroups).toEqual([
            {
                kind: "tool_exchange",
                messages: before.messages.slice(0, 2),
            },
        ]);
    });

    it("does not absorb an adjacent Tool Result for another call", () => {
        const before = {
            messages: [
                { role: "assistant", toolCalls: [{ id: "call-1", name: "search", input: {} }] },
                { role: "tool", toolCallId: "other-call", content: "orphan" },
                { role: "user", content: "继续" },
            ],
        };
        const after = { messages: [{ role: "user", content: "继续" }] };

        const diff = createContextDiff(before, after);

        expect(diff.removedGroups).toEqual([
            { kind: "tool_exchange", messages: [before.messages[0]] },
            { kind: "single", messages: [before.messages[1]] },
        ]);
    });
});
