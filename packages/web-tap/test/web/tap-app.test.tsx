import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
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
    expect(screen.getByRole("heading", { name: "Step 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Step 2" })).toBeVisible();
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
      sessionId: "session-fixture",
      turnId: "turn-broken",
      sequence: 2,
      timestamp: "2026-08-12T00:02:00.000Z",
      type: "custom.circular",
      payload: circularDetail,
    } as unknown as RuntimeEvent;
    const startEvent = {
      ...brokenEvent,
      id: "turn-broken-start",
      sequence: 1,
      timestamp: "2026-08-12T00:01:59.000Z",
      type: "turn.start",
      payload: { input: "仍可切换节点" },
    } as RuntimeEvent;
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
        sessionId: "session-fixture",
        turnId: "turn-4",
        sequence: 99,
        timestamp: "2026-08-12T00:01:39.000Z",
        type: "turn.start",
        payload: { input: "第四轮：实时追加" },
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

function fixtureEvents(): RuntimeEvent[] {
  let sequence = 0;
  const event = (
    id: string,
    type: RuntimeEvent["type"],
    turnId: string,
    payload: unknown,
    step?: number,
  ): RuntimeEvent => ({
    id,
    sessionId: "session-fixture",
    turnId,
    sequence: ++sequence,
    timestamp: `2026-08-12T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    type,
    payload,
    ...(step === undefined ? {} : { step }),
  });
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
      type: "custom.trace",
    } as unknown as RuntimeEvent,

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
