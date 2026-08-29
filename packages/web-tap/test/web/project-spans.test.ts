import type { AnyTraceSpan, TraceDocument, TraceSummary } from "@dkagent/trace";
import { describe, expect, it } from "vitest";
import { projectSpans } from "../../src/web/model/project-spans.js";

const summary: TraceSummary = {
  traceId: "trace-1",
  sessionId: "session-1",
  status: "ok",
  startedAt: "2026-08-24T00:00:00.000Z",
  endedAt: "2026-08-24T00:00:00.100Z",
  durationMs: 100,
  spanCount: 5,
  integrity: true,
};

function root(options: Partial<AnyTraceSpan> = {}): AnyTraceSpan {
  return {
    schemaVersion: 2,
    traceId: "trace-1",
    spanId: "root",
    sessionId: "session-1",
    name: "agent.turn",
    kind: "AGENT",
    status: "ok",
    sequence: 1,
    revision: 2,
    startedAt: "2026-08-24T00:00:00.000Z",
    endedAt: "2026-08-24T00:00:00.100Z",
    durationMs: 100,
    input: { userInput: "分析 test2.md" },
    output: { answer: "完成" },
    tokenUsage: null,
    attributes: {},
    events: [],
    integrity: true,
    ...options,
  } as AnyTraceSpan;
}

function step(): AnyTraceSpan {
  return {
    ...root(), spanId: "step", parentSpanId: "root", name: "agent.step", kind: "STEP",
    sequence: 2, startedAt: "2026-08-24T00:00:00.010Z", endedAt: "2026-08-24T00:00:00.090Z",
    durationMs: 80, input: { step: 1 }, output: { outcome: "answer", stopReason: "end_turn", toolCallCount: 0 },
  } as AnyTraceSpan;
}

function model(spanId: string, parentSpanId: string, sequence: number, start: number, end: number, inputTokens: number): AnyTraceSpan {
  const stamp = (value: number) => `2026-08-24T00:00:00.${String(value).padStart(3, "0")}Z`;
  return {
    ...root(), spanId, parentSpanId, name: "model.generate", kind: "LLM", sequence,
    startedAt: stamp(start), endedAt: stamp(end), durationMs: end - start,
    input: { provider: "fake", model: "fake", messages: [] },
    output: { type: "text", content: "ok", stopReason: "end_turn" },
    tokenUsage: { inputTokens, outputTokens: 2 },
  } as AnyTraceSpan;
}

function document(spans: AnyTraceSpan[]): TraceDocument {
  return {
    schemaVersion: 2,
    trace: { ...summary, spanCount: spans.length },
    spans,
    complete: true,
    diagnostics: { missingRoot: false, missingParent: [], running: [], outputMissing: [], serializationError: [] },
  };
}

describe("projectSpans", () => {
  it("每个 Span 只生成一个同 ID 节点，并按 agent.step 与 Turn 直属节点分组", () => {
    const context = {
      ...root(), spanId: "context", parentSpanId: "root", name: "context.build", kind: "CONTEXT", sequence: 5,
      input: { messageCount: 2, toolCount: 1, maxContextTokens: 1000, reservedOutputTokens: 100 },
      output: { messageCount: 2, toolCount: 1, estimatedInputTokens: 20, availableInputTokens: 900, compacted: false },
    } as AnyTraceSpan;
    const turn = projectSpans(document([context, step(), root(), model("model", "step", 3, 20, 70, 10)]));
    const nodes = turn.steps.flatMap((group) => group.nodes);

    expect(new Set(nodes.map((node) => node.id)).size).toBe(4);
    expect(turn.steps.find((group) => group.step === "turn")?.nodes.map((node) => node.id)).toEqual(["root", "context"]);
    expect(turn.steps.find((group) => group.step === 1)?.nodes.map((node) => node.id)).toEqual(["step", "model"]);
    expect(nodes.find((node) => node.id === "model")?.parentSpanId).toBe("step");
  });

  it("汇总直接与子树模型 Token，并用直接子区间并集计算自身耗时", () => {
    const first = model("model-a", "root", 2, 10, 60, 10);
    const second = model("model-b", "root", 3, 40, 80, 20);
    const turn = projectSpans(document([root(), first, second]));
    const nodes = turn.steps.flatMap((group) => group.nodes);
    const rootNode = nodes.find((node) => node.id === "root")!;
    const modelNode = nodes.find((node) => node.id === "model-a")!;

    expect(rootNode.directTokenUsage).toBeNull();
    expect(rootNode.subtreeTokenUsage).toEqual({ inputTokens: 30, outputTokens: 4 });
    expect(rootNode.selfDurationMs).toBe(30);
    expect(modelNode.directTokenUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(modelNode.subtreeTokenUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });

  it("running 或时间不完整时不猜测自身耗时，并附带完整性告警", () => {
    const { endedAt: _endedAt, durationMs: _durationMs, ...terminal } = root();
    const running = { ...terminal, status: "running", revision: 1, output: null, integrity: false } as AnyTraceSpan;
    const value = document([running]);
    value.complete = false;
    value.diagnostics.running = [running.spanId];
    const node = projectSpans(value).steps[0]?.nodes[0];
    expect(node?.selfDurationMs).toBeUndefined();
    expect(node?.integrityWarnings).toContain("running");
    expect(node?.integrityWarnings).toContain("integrity=false");
  });
});
