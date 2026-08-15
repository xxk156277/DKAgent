import type { TraceEvent } from "@dkagent/trace";
import { describe, expect, it } from "vitest";
import { analyzeAgentTurn } from "../../src/web/model/agent-turn-analysis.js";
import { projectEvents } from "../../src/web/model/project-events.js";

function traceEvent(
  id: string,
  name: TraceEvent["name"],
  phase: TraceEvent["phase"],
  data: unknown,
  options: Partial<Pick<TraceEvent, "spanId" | "parentSpanId" | "step" | "durationMs">> = {},
): TraceEvent {
  return {
    id,
    traceId: "turn-1",
    sequence: Number(id.split("-").at(-1)),
    timestamp: `2026-08-13T00:00:${id.split("-").at(-1)?.padStart(2, "0")}.000Z`,
    name,
    phase,
    data,
    ...options,
  };
}

function analyze(events: TraceEvent[]) {
  const turn = projectEvents(events)[0]?.turns[0];
  if (!turn) throw new Error("测试缺少 Turn");
  return analyzeAgentTurn(turn);
}

describe("analyzeAgentTurn", () => {
  it("aggregates a completed Tool Turn and keeps semantic quality unknown", () => {
    const result = analyze([
      traceEvent("event-1", "agent.turn", "start", { input: { input: "查天气" } }, { spanId: "turn" }),
      traceEvent("event-2", "agent.step", "start", { input: { step: 1 } }, { spanId: "step-1", parentSpanId: "turn", step: 1 }),
      traceEvent("event-3", "model.request", "start", { input: { model: "test" } }, { spanId: "model-1", parentSpanId: "step-1", step: 1 }),
      traceEvent("event-4", "model.response", "event", {
        type: "tool_use",
        usage: { inputTokens: 12, outputTokens: 4 },
      }, { spanId: "model-1", parentSpanId: "step-1", step: 1 }),
      traceEvent("event-5", "model.request", "end", { output: {} }, { spanId: "model-1", parentSpanId: "step-1", step: 1, durationMs: 20 }),
      traceEvent("event-6", "tool.call", "start", { input: { id: "call-1", name: "weather" } }, { spanId: "tool-1", parentSpanId: "step-1", step: 1 }),
      traceEvent("event-7", "tool.result", "event", {
        toolCallId: "call-1",
        result: { success: true, data: { weather: "晴" } },
      }, { spanId: "tool-1", parentSpanId: "step-1", step: 1 }),
      traceEvent("event-8", "tool.call", "end", { output: {} }, { spanId: "tool-1", parentSpanId: "step-1", step: 1, durationMs: 10 }),
      traceEvent("event-9", "context.compaction.completed", "event", {
        tokensBefore: 100,
        tokensAfter: 60,
        savedRatio: 0.4,
      }, { spanId: "context-1", parentSpanId: "step-1", step: 1 }),
      traceEvent("event-10", "agent.step", "end", { output: {} }, { spanId: "step-1", parentSpanId: "turn", step: 1, durationMs: 40 }),
      traceEvent("event-11", "agent.turn", "end", { output: { answer: "上海晴" } }, { spanId: "turn", durationMs: 50 }),
    ]);

    expect(result.metrics).toMatchObject({
      status: "completed",
      durationMs: 50,
      stepCount: 1,
      modelCallCount: 1,
      toolCallCount: 1,
      successfulToolCallCount: 1,
      inputTokens: 12,
      outputTokens: 4,
      compactionCount: 1,
      latestCompaction: { tokensBefore: 100, tokensAfter: 60, savedRatio: 0.4 },
    });
    expect(result.evaluations.find((item) => item.id === "tool_results")?.status).toBe("passed");
    expect(result.evaluations.find((item) => item.id === "context_compaction")?.status).toBe("passed");
    expect(result.evaluations.find((item) => item.id === "hallucination")?.status).toBe("unknown");
    expect(result.evaluations.find((item) => item.id === "answer_quality")?.status).toBe("unknown");
  });

  it("aggregates main and summary model calls in the same Turn", () => {
    const result = analyze([
      traceEvent("event-1", "agent.turn", "start", { input: { input: "继续" } }, { spanId: "turn" }),
      traceEvent("event-2", "context.summary.request", "start", { input: { model: "summary" } }, { spanId: "summary-1", parentSpanId: "turn" }),
      traceEvent("event-3", "context.summary.response", "event", {
        type: "text",
        content: "摘要",
        usage: { inputTokens: 30, outputTokens: 6 },
      }, { spanId: "summary-1", parentSpanId: "turn" }),
      traceEvent("event-4", "model.request", "start", { input: { model: "main" } }, { spanId: "model-1", parentSpanId: "turn", step: 1 }),
      traceEvent("event-5", "model.response", "event", {
        type: "text",
        content: "完成",
        usage: { inputTokens: 12, outputTokens: 4 },
      }, { spanId: "model-1", parentSpanId: "turn", step: 1 }),
      traceEvent("event-6", "agent.turn", "end", { output: { answer: "完成" } }, { spanId: "turn" }),
    ]);

    expect(result.metrics).toMatchObject({
      modelCallCount: 2,
      inputTokens: 42,
      outputTokens: 10,
    });
    expect(result.evaluations.find((item) => item.id === "model_pairs")?.status).toBe("passed");
  });

  it("fails model call completeness when a completed Turn lacks a summary response", () => {
    const result = analyze([
      traceEvent("event-1", "agent.turn", "start", { input: { input: "继续" } }, { spanId: "turn" }),
      traceEvent("event-2", "context.summary.request", "start", { input: { model: "summary" } }, { spanId: "summary-1", parentSpanId: "turn" }),
      traceEvent("event-3", "agent.turn", "end", { output: { answer: "完成" } }, { spanId: "turn" }),
    ]);

    expect(result.metrics.modelCallCount).toBe(1);
    expect(result.evaluations.find((item) => item.id === "model_pairs")?.status).toBe("failed");
  });

  it("does not turn missing telemetry into zero or a passing quality result", () => {
    const result = analyze([
      traceEvent("event-1", "agent.turn", "start", { input: { input: "继续" } }, { spanId: "turn" }),
      traceEvent("event-2", "agent.step", "start", { input: { step: 1 } }, { spanId: "step-1", parentSpanId: "turn", step: 1 }),
    ]);

    expect(result.metrics).toMatchObject({
      status: "running",
      stepCount: 1,
      modelCallCount: 0,
      toolCallCount: 0,
      compactionCount: 0,
    });
    expect(result.metrics.durationMs).toBeUndefined();
    expect(result.metrics.inputTokens).toBeUndefined();
    expect(result.metrics.outputTokens).toBeUndefined();
    expect(result.metrics.successfulToolCallCount).toBeUndefined();
    expect(result.evaluations.find((item) => item.id === "turn_status")?.status).toBe("unknown");
    expect(result.evaluations.find((item) => item.id === "tool_results")?.status).toBe("unknown");
  });

  it("reports explicit Tool, loop and ineffective compaction failures", () => {
    const result = analyze([
      traceEvent("event-1", "agent.turn", "start", { input: { input: "执行" } }, { spanId: "turn" }),
      traceEvent("event-2", "tool.call", "start", { input: { id: "call-1", name: "search" } }, { spanId: "tool-1", step: 1 }),
      traceEvent("event-3", "tool.result", "event", {
        toolCallId: "call-1",
        result: { success: false, error: { message: "超时" } },
      }, { spanId: "tool-1", step: 1 }),
      traceEvent("event-4", "context.compaction.completed", "event", {
        tokensBefore: 100,
        tokensAfter: 100,
        savedRatio: 0,
      }, { spanId: "context-1", step: 1 }),
      traceEvent("event-5", "agent.turn", "error", {
        error: { message: "Agent 超出最大循环次数：4" },
      }, { spanId: "turn", durationMs: 80 }),
    ]);

    expect(result.metrics.status).toBe("error");
    expect(result.metrics.successfulToolCallCount).toBe(0);
    expect(result.evaluations.find((item) => item.id === "turn_status")?.status).toBe("failed");
    expect(result.evaluations.find((item) => item.id === "tool_results")?.status).toBe("failed");
    expect(result.evaluations.find((item) => item.id === "loop_efficiency")?.status).toBe("failed");
    expect(result.evaluations.find((item) => item.id === "context_compaction")?.status).toBe("warning");
  });
});
