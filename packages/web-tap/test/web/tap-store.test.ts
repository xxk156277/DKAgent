import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { describe, expect, it } from "vitest";
import { connectEventFeed } from "../../src/web/api/event-feed.js";
import { createTapStore, selectNodes, selectSessions, selectTurns } from "../../src/web/store/tap-store.js";

function event(
  id: string,
  turnId: string,
  sequence: number,
  type: RuntimeEvent["type"] = "turn.start",
): RuntimeEvent {
  return {
    id,
    sessionId: "session-1",
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
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
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
});
