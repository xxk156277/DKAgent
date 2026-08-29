import type { AnyTraceSpan, TraceDocument } from "@dkagent/trace";
import { describe, expect, it } from "vitest";
import { analyzeAgentTurn } from "../../src/web/model/agent-turn-analysis.js";
import { projectSpans } from "../../src/web/model/project-spans.js";

function root(): AnyTraceSpan {
  return {
    schemaVersion: 2, traceId: "trace", spanId: "root", sessionId: "session", name: "agent.turn", kind: "AGENT",
    status: "ok", sequence: 1, revision: 2, startedAt: "2026-08-24T00:00:00.000Z",
    endedAt: "2026-08-24T00:00:00.050Z", durationMs: 50, input: { userInput: "test" },
    output: { answer: "done" }, tokenUsage: null, attributes: {}, events: [], integrity: true,
  };
}

function document(spans: AnyTraceSpan[], complete = true): TraceDocument {
  return {
    schemaVersion: 2,
    trace: { traceId: "trace", sessionId: "session", status: "ok", startedAt: spans[0]!.startedAt, durationMs: 50, spanCount: spans.length, integrity: complete },
    spans,
    complete,
    diagnostics: { missingRoot: false, missingParent: [], running: [], outputMissing: complete ? [] : ["root"], serializationError: [] },
  };
}

describe("analyzeAgentTurn", () => {
  it("从 Typed Span 汇总模型 Token、Tool 成功率与完整性", () => {
    const model = {
      ...root(), spanId: "model", parentSpanId: "root", name: "model.generate", kind: "LLM", sequence: 2,
      input: { provider: "fake", model: "fake", messages: [] },
      output: { type: "text", content: "done", stopReason: "end_turn" },
      tokenUsage: { inputTokens: 12, outputTokens: 4 },
    } as AnyTraceSpan;
    const tool = {
      ...root(), spanId: "tool", parentSpanId: "root", name: "tool.execute", kind: "TOOL", sequence: 3,
      input: { toolCallId: "call", name: "read_file", input: {} }, output: { success: true },
    } as AnyTraceSpan;
    const analysis = analyzeAgentTurn(projectSpans(document([root(), model, tool])));

    expect(analysis.metrics).toMatchObject({
      status: "completed", modelCallCount: 1, toolCallCount: 1, successfulToolCallCount: 1,
      inputTokens: 12, outputTokens: 4, integrityIssueCount: 0,
    });
    expect(analysis.evaluations.find((item) => item.id === "trace_integrity")?.status).toBe("passed");
    expect(analysis.evaluations.find((item) => item.id === "hallucination")?.status).toBe("unknown");
  });

  it("terminal Trace 不完整时报告失败而不伪造评测结论", () => {
    const analysis = analyzeAgentTurn(projectSpans(document([{ ...root(), integrity: false } as AnyTraceSpan], false)));
    expect(analysis.metrics.integrityIssueCount).toBeGreaterThan(0);
    expect(analysis.evaluations.find((item) => item.id === "trace_integrity")?.status).toBe("failed");
    expect(analysis.evaluations.find((item) => item.id === "answer_quality")?.summary).toContain("待评测");
  });
});
