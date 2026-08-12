import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { connectEventFeed } from "../../src/web/api/event-feed.js";
import { createTapStore, selectNodes, selectSessions, selectTurns, useTapStore } from "../../src/web/store/tap-store.js";

function event(
  id: string,
  turnId: string,
  sequence: number,
  type: RuntimeEvent["type"] = "turn.start",
  sessionId = "session-1",
): RuntimeEvent {
  return {
    id,
    sessionId,
    turnId,
    sequence,
    timestamp: `2026-08-12T00:00:0${sequence}.000Z`,
    type,
    payload: {},
  };
}

class FakeEventSource {
  static latest: FakeEventSource | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  message(value: RuntimeEvent): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function SessionSubscriber() {
  const sessions = useTapStore(selectSessions);
  return createElement("output", undefined, sessions.length);
}

describe("createTapStore", () => {
  it("selects the latest Turn and latest node on first history load", () => {
    const store = createTapStore();

    store.getState().replaceHistory([
      event("first", "turn-1", 1),
      event("latest", "turn-2", 2),
    ]);

    expect(store.getState()).toMatchObject({
      selectedSessionId: "session-1",
      selectedTurnId: "turn-2",
      selectedNodeId: "turn-2:1:turn_start:latest",
      followLive: true,
    });
  });

  it("keeps a manually selected historical Turn when live events arrive", () => {
    const store = createTapStore();
    store.getState().replaceHistory([
      event("first", "turn-1", 1),
      event("latest", "turn-2", 2),
    ]);

    store.getState().selectTurn("turn-1");
    store.getState().appendEvent(event("live", "turn-3", 3));

    expect(store.getState()).toMatchObject({
      selectedTurnId: "turn-1",
      followLive: false,
    });
  });

  it("follows the newest node while the user is already following live state", () => {
    const store = createTapStore();
    store.getState().replaceHistory([event("first", "turn-1", 1)]);

    store.getState().appendEvent(event("live", "turn-2", 2, "turn.end"));

    expect(store.getState()).toMatchObject({
      selectedTurnId: "turn-2",
      selectedNodeId: "turn-2:1:turn_end:live",
      followLive: true,
    });
  });

  it("selects the session and node from the globally newest interleaved event", () => {
    const store = createTapStore();

    store.getState().replaceHistory([
      event("a-first", "turn-a-first", 1, "turn.start", "session-a"),
      event("b-first", "turn-b", 2, "turn.start", "session-b"),
      event("a-latest", "turn-a-latest", 3, "turn.end", "session-a"),
    ]);

    expect(store.getState()).toMatchObject({
      selectedSessionId: "session-a",
      selectedTurnId: "turn-a-latest",
      selectedNodeId: "turn-a-latest:1:turn_end:a-latest",
    });
  });

  it("deduplicates an event received from both history and SSE", () => {
    const store = createTapStore();
    const duplicated = event("duplicated", "turn-1", 1);

    store.getState().replaceHistory([duplicated]);
    store.getState().appendEvent(duplicated);

    expect(store.getState().events).toEqual([duplicated]);
  });

  it("moves connection state through connecting, live and reconnecting", () => {
    const store = createTapStore();

    expect(store.getState().connectionStatus).toBe("connecting");
    store.getState().setConnectionStatus("live");
    expect(store.getState().connectionStatus).toBe("live");
    store.getState().setConnectionStatus("reconnecting");
    expect(store.getState().connectionStatus).toBe("reconnecting");
  });

  it("derives sessions, turns and nodes from events instead of storing projections", () => {
    const store = createTapStore();
    store.getState().replaceHistory([event("first", "turn-1", 1)]);
    const state = store.getState();

    expect(selectSessions(state).map((session) => session.id)).toEqual(["session-1"]);
    expect(selectTurns(state).map((turn) => turn.id)).toEqual(["turn-1"]);
    expect(selectNodes(state).map((node) => node.id)).toEqual(["turn-1:1:turn_start:first"]);
  });

  it("returns stable projection references for the same events snapshot", () => {
    const store = createTapStore();
    store.getState().replaceHistory([event("first", "turn-1", 1)]);
    const state = store.getState();

    expect(selectSessions(state)).toBe(selectSessions(state));
    expect(selectTurns(state)).toBe(selectTurns(state));
    expect(selectNodes(state)).toBe(selectNodes(state));
  });

  it("does not warn when a component subscribes to projected sessions", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(createElement(SessionSubscriber));

    expect(screen.getByRole("status").textContent).toBe("0");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("getSnapshot");
    consoleError.mockRestore();
  });

  it("merges history with events received during the history request", async () => {
    const store = createTapStore();
    const history = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const fetch = () => history.promise;

    connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    const source = FakeEventSource.latest!;
    source.message(event("live", "turn-live", 2));
    history.resolve({ json: async () => [event("history", "turn-history", 1)] });
    await Promise.resolve();
    await Promise.resolve();

    expect(source.url).toBe("/api/events/stream");
    expect(store.getState().events.map((item) => item.id)).toEqual(["history", "live"]);
  });

  it("reloads history on SSE open and marks errors as reconnecting", async () => {
    const store = createTapStore();
    let fetchCount = 0;
    const fetch = async () => ({ json: async () => [event(`history-${++fetchCount}`, "turn-1", fetchCount)] });

    connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    const source = FakeEventSource.latest!;
    await Promise.resolve();
    source.open();
    await Promise.resolve();
    source.onerror?.(new Event("error"));

    expect(fetchCount).toBe(2);
    expect(store.getState().connectionStatus).toBe("reconnecting");
  });

  it("prevents late history writes after cleanup", async () => {
    const store = createTapStore();
    const history = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const cleanup = connectEventFeed(store, { fetch: () => history.promise, EventSource: FakeEventSource });
    const source = FakeEventSource.latest!;

    cleanup();
    history.resolve({ json: async () => [event("late", "turn-late", 1)] });
    await Promise.resolve();
    await Promise.resolve();

    expect(source.closed).toBe(true);
    expect(store.getState().events).toEqual([]);
  });

  it("ignores an older history response after a newer SSE open request", async () => {
    const store = createTapStore();
    const firstHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const secondHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const fetch = vi.fn()
      .mockReturnValueOnce(firstHistory.promise)
      .mockReturnValueOnce(secondHistory.promise);

    connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    FakeEventSource.latest!.open();
    secondHistory.resolve({ json: async () => [event("newer", "turn-newer", 2)] });
    await Promise.resolve();
    await Promise.resolve();
    firstHistory.resolve({ json: async () => [event("older", "turn-older", 1)] });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().events.map((item) => item.id)).toEqual(["newer"]);
  });

  it("ignores an older history rejection after the feed has started reconnecting", async () => {
    const store = createTapStore();
    const firstHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const secondHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const fetch = vi.fn()
      .mockReturnValueOnce(firstHistory.promise)
      .mockReturnValueOnce(secondHistory.promise);

    connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    const source = FakeEventSource.latest!;
    source.open();
    source.onerror?.(new Event("error"));
    firstHistory.reject(new Error("stale history"));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().connectionStatus).toBe("reconnecting");
  });

  it("ignores an older connection rejection after a newer connection is live", async () => {
    const store = createTapStore();
    const oldHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const newHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const refreshedHistory = deferred<{ json(): Promise<RuntimeEvent[]> }>();
    const fetch = vi.fn()
      .mockReturnValueOnce(oldHistory.promise)
      .mockReturnValueOnce(newHistory.promise)
      .mockReturnValueOnce(refreshedHistory.promise);

    const closeOld = connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    const closeNew = connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    FakeEventSource.latest!.open();
    oldHistory.reject(new Error("old connection"));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().connectionStatus).toBe("live");
    closeOld();
    closeNew();
  });

  it("does not change status or fetch when a closed feed receives a late open", () => {
    const store = createTapStore();
    const fetch = vi.fn(() => deferred<{ json(): Promise<RuntimeEvent[]> }>().promise);
    const cleanup = connectEventFeed(store, { fetch, EventSource: FakeEventSource });
    const source = FakeEventSource.latest!;

    cleanup();
    source.open();

    expect(store.getState().connectionStatus).toBe("connecting");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
