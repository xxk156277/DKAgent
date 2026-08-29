import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebTapRoutes } from "../../src/web/app/WebTapRouter.js";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
});

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  close() {}

  message(value: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Session pages", () => {
  it("从可搜索的 Session 列表进入无 Trace 的真实消息历史", async () => {
    const sessions = [
      {
        id: "session-1",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:01:00.000Z",
        preview: "分析 AgentLoop",
        messageCount: 2,
        turnCount: 1,
        hasTrace: false,
      },
      {
        id: "session-2",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:01:00.000Z",
        preview: "另一段对话",
        messageCount: 2,
        turnCount: 1,
        hasTrace: false,
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions") return jsonResponse(sessions);
      if (url === "/api/sessions/session-1") return jsonResponse({
        id: "session-1",
        createdAt: sessions[0]?.createdAt,
        updatedAt: sessions[0]?.updatedAt,
        messages: [
          { role: "user", content: "分析 AgentLoop" },
          { role: "assistant", content: "历史回答" },
        ],
        contextSummary: "",
      });
      return jsonResponse({ error: "接口不存在" }, 404);
    }));

    render(<MemoryRouter initialEntries={["/"]}><WebTapRoutes /></MemoryRouter>);

    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeVisible();
    const search = screen.getByRole("textbox", { name: "搜索 Session" });
    fireEvent.change(search, { target: { value: "AgentLoop" } });
    expect(screen.getByText("分析 AgentLoop")).toBeVisible();
    expect(screen.queryByText("另一段对话")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /分析 AgentLoop/ }));

    expect(await screen.findByText("暂无运行轨迹")).toBeVisible();
    expect(screen.getByText("历史回答")).toBeVisible();
    expect(screen.queryByText("Agent 运行指标")).not.toBeInTheDocument();
  });

  it("Session 不存在时提供返回列表入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Session 不存在" }, 404)));

    render(<MemoryRouter initialEntries={["/sessions/missing"]}><WebTapRoutes /></MemoryRouter>);

    expect(await screen.findByText("Session 不存在")).toBeVisible();
    expect(screen.getByRole("link", { name: "返回 Session 列表" })).toHaveAttribute("href", "/");
  });

  it("无 Trace 详情持续监听并在首个事件到达后切换到运行工作区", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/traces")) return jsonResponse([]);
      return jsonResponse({
        id: "session-live",
        createdAt: "2026-08-18T00:00:00.000Z",
        updatedAt: "2026-08-18T00:01:00.000Z",
        messages: [{ role: "user", content: "等待运行" }],
        contextSummary: "",
      });
    }));

    render(<MemoryRouter initialEntries={["/sessions/session-live"]}><WebTapRoutes /></MemoryRouter>);
    expect(await screen.findByText("暂无运行轨迹")).toBeVisible();

    FakeEventSource.latest?.message({
      type: "span_started",
      traceId: "turn-live",
      span: {
        schemaVersion: 2,
        sessionId: "session-live",
        traceId: "turn-live",
        spanId: "span-live",
        sequence: 1,
        revision: 1,
        startedAt: "2026-08-18T00:01:01.000Z",
        name: "agent.turn",
        kind: "AGENT",
        status: "running",
        input: { userInput: "开始运行" },
        output: null,
        tokenUsage: null,
        attributes: {},
        events: [],
        integrity: true,
      },
    });

    expect(await screen.findByRole("button", { name: /^第 1 轮/ })).toBeVisible();
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}
