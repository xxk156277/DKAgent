import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    renderFixture();

    expect(screen.getByRole("button", { name: /^第 1 轮/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^第 2 轮/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^第 3 轮/ })).toBeVisible();
    expect(screen.queryByText("Session 列表")).not.toBeInTheDocument();
    expect(screen.queryByText("/", { exact: true })).not.toBeInTheDocument();
  });

  it("switches Turn and groups its nodes by Step", () => {
    renderFixture();

    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    expect(screen.getByRole("heading", { name: "第 2 轮节点" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Step 1" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Step 2" })).toBeVisible();
  });

  it("selects the model request and renders its request JSON", () => {
    renderFixture();
    fireEvent.click(screen.getByRole("button", { name: /^第 2 轮/ }));

    fireEvent.click(screen.getAllByRole("button", { name: /模型请求/ })[0]!);

    expect(screen.getByRole("heading", { name: "模型请求" })).toBeVisible();
    expect(screen.getByText("request")).toBeVisible();
    expect(screen.getByText(/"model": "fixture-model"/)).toBeVisible();
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
  return render(<TapApp store={store} />);
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
    model: "fixture-model",
    messages: [{ role: "user", content: "帮我查天气" }],
    tools: [{ name: "weather" }],
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

    event("turn-2-start", "turn.start", "turn-2", { input: "第二轮：帮我查询上海天气" }),
    event("turn-2-before-1", "context.before", "turn-2", context([]), 1),
    event("turn-2-after-1", "context.after", "turn-2", { ...context([]), droppedMessageCount: 0 }, 1),
    event("turn-2-model-1", "model.response", "turn-2", {
      request,
      response: {
        type: "tool_use",
        toolCalls: [{ id: "call-weather", name: "weather", input: { city: "上海" } }],
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
