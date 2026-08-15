import type { TraceEvent, TraceEventName, TracePhase } from "@dkagent/trace";
import { describe, expect, it } from "vitest";
import { createContextDiff } from "../../src/web/model/context-diff.js";
import { projectEvents } from "../../src/web/model/project-events.js";

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

function event(
  type: string,
  turnId: string,
  payload: unknown,
  step?: number,
): TraceEvent {
  const mapped = legacyEvent(type, payload);
  return {
    id: `event-${turnId}-${type}-${step ?? 0}`,
    traceId: turnId,
    sequence: sequence += 1,
    timestamp: "2026-08-12T00:00:00.000Z",
    name: mapped.name,
    phase: mapped.phase,
    data: mapped.data,
    ...(step === undefined ? {} : { step }),
  };
}

function legacyEvent(type: string, payload: unknown): {
  name: TraceEventName;
  phase: TracePhase;
  data: unknown;
} {
  switch (type) {
    case "turn.start": return { name: "agent.turn", phase: "start", data: { input: payload } };
    case "turn.end": return { name: "agent.turn", phase: "end", data: { output: payload } };
    case "context.before": return { name: "context.build", phase: "start", data: { input: payload } };
    case "context.after": return {
      name: "context.snapshot.created",
      phase: "event",
      data: {
        context: payload,
        metrics: { droppedMessageCount: isRecord(payload) ? payload.droppedMessageCount ?? 0 : 0 },
      },
    };
    case "model.response": return { name: "model.response", phase: "event", data: payload };
    case "tool.call": return { name: "tool.call", phase: "start", data: { input: payload } };
    case "tool.result": return { name: "tool.result", phase: "event", data: payload };
    default: return { name: type as TraceEventName, phase: "event", data: payload };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let sequence = 0;

describe("projectEvents", () => {
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
    expect(step?.nodes[3]?.id).toContain("turn-1:1:model_request");
    expect(step?.nodes[4]?.id).toContain("turn-1:1:model_response");
  });

  it("projects Tool Call and Result in Step 1, then model nodes in Step 2", () => {
    sequence = 0;
    const toolTurn = [
      event("turn.start", "turn-tool", { input: "帮我查" }),
      event("context.before", "turn-tool", beforePayload, 1),
      event("context.after", "turn-tool", afterPayload, 1),
      event("model.response", "turn-tool", {
        request,
        response: {
          type: "tool_use",
          toolCalls: [{ id: "call-1", name: "search", input: { q: "DKAgent" } }],
          usage: { inputTokens: 4, outputTokens: 2 },
          stopReason: "tool_use",
        },
      }, 1),
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
      { ...event("turn.end", "turn-trim", { answer: "你好" }, 1), name: "custom.trace" as TraceEventName, phase: "event" as const },
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
        { role: "tool", toolCallId: "call-1", content: "{\"success\":true}" },
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
