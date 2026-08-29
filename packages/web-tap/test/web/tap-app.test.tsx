import type { AnyTraceSpan, TraceDocument } from "@dkagent/trace";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TapApp } from "../../src/web/app/TapApp.js";
import { createTapStore } from "../../src/web/store/tap-store.js";

class ResizeObserverMock { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: ResizeObserverMock });

beforeEach(() => setViewport(1440));
afterEach(cleanup);

function root(status: "running" | "ok" | "error" = "ok"): AnyTraceSpan {
  return {
    schemaVersion: 2, traceId: "trace", spanId: "root", sessionId: "session", name: "agent.turn", kind: "AGENT",
    status, sequence: 1, revision: status === "running" ? 1 : 2, startedAt: "2026-08-24T00:00:00.000Z",
    ...(status === "running" ? {} : { endedAt: "2026-08-24T00:00:00.100Z", durationMs: 100 }),
    input: { userInput: "分析 test2.md" }, output: status === "running" ? null : { answer: "完成" },
    ...(status === "error" ? { error: { name: "ProviderError", code: "MODEL_FAILED" } } : {}),
    tokenUsage: null, attributes: {}, events: [], integrity: status !== "running",
  };
}

function model(): AnyTraceSpan {
  return {
    ...root(), spanId: "model", parentSpanId: "root", name: "model.generate", kind: "LLM", sequence: 2,
    startedAt: "2026-08-24T00:00:00.010Z", endedAt: "2026-08-24T00:00:00.060Z", durationMs: 50,
    input: { provider: "fake", model: "demo", messages: [{ role: "user", content: "分析 test2.md" }] },
    output: { type: "text", content: "完成", stopReason: "end_turn" }, tokenUsage: { inputTokens: 12, outputTokens: 4 },
    events: [{ name: "context.tokens.counted", timestamp: "2026-08-24T00:00:00.011Z", sequence: 1, data: { tokens: 12 } }],
  } as AnyTraceSpan;
}

function context(): AnyTraceSpan {
  return {
    ...root(), spanId: "context", parentSpanId: "root", name: "context.build", kind: "CONTEXT", sequence: 3,
    input: { messageCount: 3, toolCount: 2, maxContextTokens: 32000, reservedOutputTokens: 4096 },
    output: { messageCount: 3, toolCount: 2, estimatedInputTokens: 120, availableInputTokens: 27904, compacted: false },
  } as AnyTraceSpan;
}

function document(spans: AnyTraceSpan[] = [root(), model(), context()]): TraceDocument {
  return {
    schemaVersion: 2,
    trace: {
      traceId: "trace", sessionId: "session", status: spans[0]!.status, startedAt: spans[0]!.startedAt,
      ...(spans[0]!.durationMs === undefined ? {} : { durationMs: spans[0]!.durationMs }),
      spanCount: spans.length, integrity: true,
    },
    spans,
    complete: spans.every((span) => span.status !== "running"),
    diagnostics: { missingRoot: false, missingParent: [], running: spans.filter((span) => span.status === "running").map((span) => span.spanId), outputMissing: [], serializationError: [] },
  };
}

function renderDocument(value = document()) {
  const store = createTapStore();
  act(() => store.getState().mergeTraceDocument(value));
  render(<TapApp store={store} connectLive={false} />);
  return store;
}

describe("TapApp Typed Span UI", () => {
  it("一个 Span 一个节点，并展示输入输出、Token、耗时与 Event", () => {
    renderDocument();
    expect(screen.getAllByRole("button", { name: /Agent Turn|Model · demo|context.build/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /Model · demo/ }));
    expect(screen.getByRole("heading", { name: "Model · demo" })).toBeVisible();
    expect(screen.getByRole("row", { name: "直接 Token 12 / 4" })).toBeVisible();
    expect(screen.getByRole("row", { name: "总耗时 50 毫秒" })).toBeVisible();
    expect(screen.getByText("最终请求消息")).toBeVisible();
    expect(screen.getByText(/context.tokens.counted/)).toBeVisible();
    expect(screen.getByText("输入")).toBeVisible();
    expect(screen.getByText("输出")).toBeVisible();
  });

  it("Context 只展示指标，不出现 before/after 消息 Diff", () => {
    renderDocument();
    fireEvent.click(screen.getByRole("button", { name: /context.build/ }));
    expect(screen.getAllByText(/"messageCount": 3/)).toHaveLength(2);
    expect(screen.getByText(/"estimatedInputTokens": 120/)).toBeVisible();
    expect(screen.queryByText("移除的消息组")).not.toBeInTheDocument();
  });

  it("running Span 显示未完成与完整性告警", () => {
    const running = root("running");
    const value = document([running]);
    value.trace.integrity = false;
    renderDocument(value);
    expect(screen.getByText("Trace 完整性告警")).toBeVisible();
    expect(screen.getAllByText("未完成").length).toBeGreaterThan(0);
  });

  it("移动端可打开 Trace 列表和 Agent 指标", async () => {
    setViewport(390);
    renderDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开对话轮次" }));
    expect(screen.getByRole("dialog", { name: "对话轮次" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭对话轮次" }));
    fireEvent.click(screen.getByRole("button", { name: "打开 Agent 指标" }));
    const drawer = await screen.findByRole("dialog", { name: "Agent 指标" });
    expect(within(drawer).getByText("12 / 4")).toBeVisible();
  });

  it("空 Store 展示空态", () => {
    render(<TapApp store={createTapStore()} connectLive={false} />);
    expect(screen.getByText("暂无对话轮次")).toBeVisible();
    expect(screen.getByText("尚未选择节点")).toBeVisible();
  });
});

function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}
