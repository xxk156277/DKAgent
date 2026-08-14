import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TraceEvent, TraceEventName, TracePhase } from "@dkagent/trace";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TapApp } from "../../src/web/app/TapApp.js";
import { createTapStore } from "../../src/web/store/tap-store.js";

const clipboardWrite = vi.fn<() => Promise<void>>();

beforeEach(() => {
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(cleanup);

describe("TapApp", () => {
  it("lays out Turn, Node, and Detail as flexible regions in DOM order", () => {
    renderFixture();

    const complementaryRegions = screen.getAllByRole("complementary");
    expect(complementaryRegions).toHaveLength(2);
    const turnRegion = complementaryRegions[0]!;
    const nodeRegion = complementaryRegions[1]!;
    const detailRegion = screen.getByRole("main");
    expect([turnRegion, nodeRegion, detailRegion].map((region) => region.className)).toEqual([
      expect.stringContaining("tap-turn-region"),
      expect.stringContaining("tap-node-region"),
      expect.stringContaining("tap-detail-region"),
    ]);
    expect(turnRegion.compareDocumentPosition(nodeRegion)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(nodeRegion.compareDocumentPosition(detailRegion)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const styles = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
    expect(styles).toMatch(/\.tap-app-shell\s*\{[^}]*display:\s*flex;/s);
    expect(styles).toMatch(/\.tap-node-region\s*\{[^}]*flex:\s*0\s+0\s+350px;/s);
    expect(styles).toMatch(/\.tap-detail-region\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
    expect(styles).toMatch(/\.tap-detail-region\s*\{[^}]*min-width:\s*0;/s);
  });

  it("keeps Flex wrapping and visual order responsive at each breakpoint", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
    const tabletStyles = getMediaBlock(styles, 959);
    const mobileStyles = getMediaBlock(styles, 639);

    expect(tabletStyles).toMatch(/\.tap-app-shell\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(tabletStyles).toMatch(/\.tap-detail-region\s*\{[^}]*flex:\s*0\s+0\s+calc\(100%\s*-\s*240px\);/s);
    expect(tabletStyles).toMatch(/\.tap-node-region\s*\{[^}]*order:\s*3;/s);
    expect(tabletStyles).toMatch(/\.tap-node-region\s*\{[^}]*flex-basis:\s*100%;/s);
    expect(mobileStyles).toMatch(
      /\.tap-turn-region,\s*\.tap-node-region,\s*\.tap-detail-region\s*\{[^}]*flex:\s*0\s+0\s+100%;/s,
    );
    expect(mobileStyles).toMatch(/\.tap-node-region\s*\{[^}]*order:\s*0;/s);
  });

  it("uses one desktop divider and clears obsolete dividers when wrapping", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/web/styles.css"), "utf8");
    const desktopStyles = styles.slice(0, styles.indexOf("@media"));
    const tabletStyles = getMediaBlock(styles, 959);
    const mobileStyles = getMediaBlock(styles, 639);

    expect(desktopStyles).toMatch(/\.tap-node-region\s*\{[^}]*border-inline-end:\s*1px\s+solid/s);
    expect(desktopStyles).not.toMatch(/\.tap-node-region\s*\{[^}]*border-inline-start:/s);
    expect(tabletStyles).toMatch(/\.tap-node-region\s*\{[^}]*border-inline-end:\s*0;/s);
    expect(mobileStyles).toMatch(/\.tap-turn-region\s*\{[^}]*border-inline-end:\s*0;/s);
    expect(mobileStyles).toMatch(/\.tap-node-region\s*\{[^}]*border-block-start:\s*0;/s);
  });

  it("renders three Turns without Session navigation or breadcrumbs", () => {
    const { container } = renderFixture();

    expect(screen.getByRole("button", { name: /^第 1 轮/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^第 2 轮/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^第 3 轮/ })).toBeVisible();
    expect(screen.queryByText("Session 列表")).not.toBeInTheDocument();
    expect(container.querySelector(".ant-breadcrumb, [aria-label*='breadcrumb' i]")).toBeNull();
    expect(container.querySelector("input, textarea, [contenteditable='true']")).toBeNull();
  });

  it("switches Turn and groups its nodes by Step", () => {
    renderFixture();

    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    expect(screen.getByRole("heading", { name: "第 2 轮节点" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Step 1/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Step 2/ })).toBeVisible();
  });

  it("shows Agent facts, rule checks, and unknown semantic evaluations", () => {
    renderFixture(agentMetricsFixture());

    const metrics = screen.getByRole("region", { name: "Agent 运行指标" });
    expect(within(metrics).getByText("已完成")).toBeVisible();
    expect(within(metrics).getByText("50 毫秒")).toBeVisible();
    expect(within(metrics).getByText("12 / 4")).toBeVisible();
    expect(within(metrics).getByText("1 / 1 成功")).toBeVisible();
    expect(within(metrics).getByText("100 → 60（节省 40.0%）")).toBeVisible();

    const evaluation = screen.getByRole("region", { name: "Agent 轨迹评价" });
    expect(within(evaluation).getByText("Tool 执行结果")).toBeVisible();
    expect(within(evaluation).getAllByText("通过").length).toBeGreaterThan(0);
    expect(within(evaluation).getByText("幻觉")).toBeVisible();
    expect(within(evaluation).getByText("待评测：需要外部事实依据或参考答案")).toBeVisible();
  });

  it("updates Agent analysis when selecting another Turn", () => {
    renderFixture(agentMetricsFixtureWithRunningTurn());

    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    const metrics = screen.getByRole("region", { name: "Agent 运行指标" });
    expect(within(metrics).getByText("进行中")).toBeVisible();
    expect(within(metrics).getAllByText("未记录").length).toBeGreaterThan(0);

    const evaluation = screen.getByRole("region", { name: "Agent 轨迹评价" });
    expect(within(evaluation).getByText("本轮仍在运行，尚不能判断是否完成")).toBeVisible();
  });

  it("marks every non-error node completed after its Turn ends", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    const navigation = screen.getByRole("complementary", { name: "第 2 轮节点" });
    expect(within(navigation).queryByText("进行中")).not.toBeInTheDocument();
    expect(within(navigation).queryByText("当前")).not.toBeInTheDocument();
    expect(within(navigation).getAllByText("已完成")).toHaveLength(12);
  });

  it("renders model request fields and role-grouped messages semantically", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    fireEvent.click(screen.getAllByRole("button", { name: /模型请求/ })[0]!);

    expect(screen.getByRole("heading", { name: "模型请求" })).toBeVisible();
    expect(screen.getByRole("row", { name: "系统提示词 你是天气助手" })).toBeVisible();
    expect(screen.getByRole("row", { name: "最大输出 Token 256" })).toBeVisible();
    expect(screen.getByRole("row", { name: "温度 0" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "systemPrompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "maxTokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "temperature" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /System 消息/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /User 消息/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Assistant 消息/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Tool 消息/ })).toBeVisible();
    expect(screen.getByText("原始 JSON")).toBeVisible();
  });

  it("renders model response stop reason and usage semantically", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    fireEvent.click(screen.getAllByRole("button", { name: /模型响应/ })[0]!);

    expect(screen.queryByRole("columnheader", { name: "模型" })).not.toBeInTheDocument();
    expect(screen.queryByText("—", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "停止原因" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "用量" })).toBeVisible();
    expect(screen.getByRole("row", { name: "停止原因 tool_use" })).toBeVisible();
    expect(screen.getByText("原始 JSON")).toBeVisible();
  });

  it("visually pairs Tool Call and Result with the same toolCallId", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    const call = screen.getByRole("button", { name: /Tool 调用/ });
    const result = screen.getByRole("button", { name: /Tool 结果/ });
    expect(call).toHaveAttribute("data-tool-call-id", "call-weather");
    expect(result).toHaveAttribute("data-tool-call-id", "call-weather");
    expect(call).toHaveAttribute("data-tool-pair", "start");
    expect(result).toHaveAttribute("data-tool-pair", "end");
  });

  it("falls back to raw JSON for an unknown node", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 1 轮/ }));
    fireEvent.click(screen.getByRole("button", { name: /未知事件/ }));

    expect(screen.getByRole("heading", { name: "未知事件" })).toBeVisible();
    expect(screen.getByText("未知节点数据")).toBeVisible();
    expect(screen.getByText(/"traceMarker": "unknown-fixture"/)).toBeVisible();
  });

  it("keeps both navigations visible when the selected node renderer throws", () => {
    const circularDetail: Record<string, unknown> = { marker: "circular-fixture" };
    circularDetail.self = circularDetail;
    const brokenEvent = {
      id: "turn-broken-event",
      traceId: "turn-broken",
      sequence: 2,
      timestamp: "2026-08-12T00:02:00.000Z",
      name: "custom.circular" as TraceEventName,
      phase: "event" as const,
      data: circularDetail,
    } as TraceEvent;
    const startEvent = {
      ...brokenEvent,
      id: "turn-broken-start",
      sequence: 1,
      timestamp: "2026-08-12T00:01:59.000Z",
      name: "agent.turn",
      phase: "start" as const,
      data: { input: { input: "仍可切换节点" } },
    } as TraceEvent;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      renderFixture([startEvent, brokenEvent]);

      expect(screen.getByRole("button", { name: /^第 1 轮/ })).toBeVisible();
      expect(screen.getByRole("complementary", { name: "第 1 轮节点" })).toBeVisible();
      expect(screen.getByText("节点详情展示失败")).toBeVisible();
      expect(screen.getByText(/"self": "\[Circular\]"/)).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: /对话开始/ }));
      expect(screen.getByRole("heading", { name: "对话开始" })).toBeVisible();
      expect(screen.queryByText("节点详情展示失败")).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("subscribes to later Store updates and marks the latest active node current", () => {
    const { store } = renderFixture();

    act(() => {
      store.getState().appendEvent({
        id: "turn-4-start",
        traceId: "turn-4",
        sequence: 99,
        timestamp: "2026-08-12T00:01:39.000Z",
        name: "agent.turn",
        phase: "start",
        data: { input: { input: "第四轮：实时追加" } },
      });
    });

    expect(screen.getByRole("button", { name: /^第 4 轮/ })).toBeVisible();
    const navigation = screen.getByRole("complementary", { name: "第 4 轮节点" });
    expect(within(navigation).getByText("当前")).toBeVisible();
  });

  it("renders context trim counts and removed messages, then copies raw events", async () => {
    const events = fixtureEvents();
    renderFixture(events);
    fireEvent.click(screen.getByRole("button", { name: /^第 3 轮/ }));
    fireEvent.click(screen.getByRole("button", { name: /上下文已裁剪/ }));

    expect(screen.getByRole("heading", { name: "上下文裁剪" })).toBeVisible();
    expect(screen.getByText("裁剪前")).toBeVisible();
    expect(screen.getByText("裁剪后")).toBeVisible();
    expect(screen.getByText(/旧问题需要移除/)).toBeVisible();

    fireEvent.click(screen.getByText("原始 JSON"));
    fireEvent.click(await screen.findByRole("button", { name: "复制 JSON" }));

    const trimEvents = events.filter((event) => event.id === "turn-3-before" || event.id === "turn-3-after");
    expect(clipboardWrite).toHaveBeenCalledWith(JSON.stringify(trimEvents, null, 2));
  });

  it("reports clipboard rejection without closing the detail panel", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("clipboard denied"));
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 3 轮/ }));
    fireEvent.click(screen.getByRole("button", { name: /上下文已裁剪/ }));
    fireEvent.click(screen.getByText("原始 JSON"));
    fireEvent.click(await screen.findByRole("button", { name: "复制 JSON" }));

    await waitFor(() => {
      expect(screen.getByText("复制失败，请检查剪贴板权限")).toBeVisible();
    });
    expect(screen.getByRole("heading", { name: "上下文裁剪" })).toBeVisible();
  });
});

function renderFixture(events = fixtureEvents()) {
  const store = createTapStore();
  store.getState().replaceHistory(events);
  return { store, ...render(<TapApp store={store} />) };
}

function metricEvent(
  id: string,
  traceId: string,
  name: TraceEvent["name"],
  phase: TraceEvent["phase"],
  data: unknown,
  options: Partial<Pick<TraceEvent, "spanId" | "parentSpanId" | "step" | "durationMs">> = {},
): TraceEvent {
  const sequence = Number(id.split("-").at(-1));
  return {
    id,
    traceId,
    sequence,
    timestamp: `2026-08-13T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    name,
    phase,
    data,
    ...options,
  };
}

function agentMetricsFixture(): TraceEvent[] {
  return [
    metricEvent("metric-1", "turn-1", "agent.turn", "start", { input: { input: "查天气" } }, { spanId: "turn-1" }),
    metricEvent("metric-2", "turn-1", "agent.step", "start", { input: { step: 1 } }, { spanId: "step-1", parentSpanId: "turn-1", step: 1 }),
    metricEvent("metric-3", "turn-1", "model.request", "start", { input: { model: "test" } }, { spanId: "model-1", parentSpanId: "step-1", step: 1 }),
    metricEvent("metric-4", "turn-1", "model.response", "event", {
      type: "tool_use",
      usage: { inputTokens: 12, outputTokens: 4 },
    }, { spanId: "model-1", parentSpanId: "step-1", step: 1 }),
    metricEvent("metric-5", "turn-1", "tool.call", "start", {
      input: { id: "call-1", name: "weather", input: { city: "上海" } },
    }, { spanId: "tool-1", parentSpanId: "step-1", step: 1 }),
    metricEvent("metric-6", "turn-1", "tool.result", "event", {
      toolCallId: "call-1",
      name: "weather",
      result: { success: true, data: { weather: "晴" } },
    }, { spanId: "tool-1", parentSpanId: "step-1", step: 1 }),
    metricEvent("metric-7", "turn-1", "context.compaction.completed", "event", {
      tokensBefore: 100,
      tokensAfter: 60,
      savedRatio: 0.4,
    }, { spanId: "context-1", parentSpanId: "step-1", step: 1 }),
    metricEvent("metric-8", "turn-1", "agent.step", "end", { output: {} }, { spanId: "step-1", parentSpanId: "turn-1", step: 1, durationMs: 40 }),
    metricEvent("metric-9", "turn-1", "agent.turn", "end", { output: { answer: "上海晴" } }, { spanId: "turn-1", durationMs: 50 }),
  ];
}

function agentMetricsFixtureWithRunningTurn(): TraceEvent[] {
  return [
    ...agentMetricsFixture(),
    metricEvent("metric-10", "turn-2", "agent.turn", "start", { input: { input: "继续" } }, { spanId: "turn-2" }),
    metricEvent("metric-11", "turn-2", "agent.step", "start", { input: { step: 1 } }, { spanId: "step-2", parentSpanId: "turn-2", step: 1 }),
  ];
}

/** 仅截取指定断点，避免 CSS 契约跨媒体查询误匹配。 */
function getMediaBlock(styles: string, maxWidth: number) {
  const start = styles.indexOf(`@media (max-width: ${maxWidth}px) {`);
  if (start === -1) return "";

  const nextMedia = styles.indexOf("@media", start + 1);

  return styles.slice(start, nextMedia === -1 ? undefined : nextMedia);
}

function fixtureEvents(): TraceEvent[] {
  let sequence = 0;
  const event = (
    id: string,
    type: string,
    turnId: string,
    payload: unknown,
    step?: number,
  ): TraceEvent => {
    const mapped = legacyEvent(type, payload);
    return {
      id,
      traceId: turnId,
      sequence: ++sequence,
      timestamp: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      name: mapped.name,
      phase: mapped.phase,
      data: mapped.data,
      ...(step === undefined ? {} : { step }),
    };
  };
  const request = {
    systemPrompt: "你是天气助手",
    messages: [
      { role: "system", content: "你是天气助手" },
      { role: "user", content: "帮我查天气" },
      { role: "assistant", toolCalls: [{ id: "call-weather", name: "weather", input: { city: "上海" } }] },
      { role: "tool", toolCallId: "call-weather", content: "晴" },
    ],
    tools: [{ name: "weather" }],
    maxTokens: 256,
    temperature: 0,
  };
  const response = {
    type: "text",
    content: "上海晴",
    usage: { inputTokens: 12, outputTokens: 4 },
    stopReason: "end_turn",
  };
  const context = (messages: unknown[]) => ({
    messages,
    maxContextTokens: 100,
    reservedOutputTokens: 20,
    estimatedInputTokens: 24,
    availableInputTokens: 80,
  });

  return [
    event("turn-1-start", "turn.start", "turn-1", { input: "第一轮：你好" }),
    event("turn-1-model", "model.response", "turn-1", { request, response }, 1),
    event("turn-1-end", "turn.end", "turn-1", { answer: "你好" }, 1),
    {
      ...event("turn-1-unknown", "turn.end", "turn-1", { traceMarker: "unknown-fixture" }, 1),
      name: "custom.trace" as TraceEventName,
      phase: "event" as const,
    },

    event("turn-2-start", "turn.start", "turn-2", { input: "第二轮：帮我查询上海天气" }),
    event("turn-2-before-1", "context.before", "turn-2", context([]), 1),
    event("turn-2-after-1", "context.after", "turn-2", { ...context([]), droppedMessageCount: 0 }, 1),
    event("turn-2-model-1", "model.response", "turn-2", {
      request,
      response: {
        type: "tool_use",
        toolCalls: [{ id: "call-weather", name: "weather", input: { city: "上海" } }],
        usage: { inputTokens: 12, outputTokens: 4 },
        stopReason: "tool_use",
      },
    }, 1),
    event("turn-2-call", "tool.call", "turn-2", {
      id: "call-weather",
      name: "weather",
      input: { city: "上海" },
    }, 1),
    event("turn-2-result", "tool.result", "turn-2", {
      toolCallId: "call-weather",
      name: "weather",
      result: { weather: "晴" },
    }, 1),
    event("turn-2-before-2", "context.before", "turn-2", context([]), 2),
    event("turn-2-after-2", "context.after", "turn-2", { ...context([]), droppedMessageCount: 0 }, 2),
    event("turn-2-model-2", "model.response", "turn-2", { request, response }, 2),
    event("turn-2-end", "turn.end", "turn-2", { answer: "上海晴" }, 2),

    event("turn-3-start", "turn.start", "turn-3", { input: "第三轮：继续，并裁剪旧上下文" }),
    event("turn-3-before", "context.before", "turn-3", context([
      { role: "user", content: "旧问题需要移除" },
      { role: "user", content: "当前问题需要保留" },
    ]), 1),
    event("turn-3-after", "context.after", "turn-3", {
      ...context([{ role: "user", content: "当前问题需要保留" }]),
      triggerReason: "输入 Token 超出预算",
      estimatedInputTokens: 12,
      droppedMessageCount: 1,
    }, 1),
    event("turn-3-end", "turn.end", "turn-3", { answer: "已完成" }, 1),
  ];
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
