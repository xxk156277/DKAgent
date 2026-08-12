import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryTraceStore, type TraceEvent } from "@dkagent/trace";

import {
  createViewerEventFeed,
  mergeViewerEvents,
} from "../src/tap/viewer-state.js";

const firstEvent: TraceEvent = {
  id: "event-1",
  traceId: "session-1",
  sequence: 1,
  timestamp: "2026-08-12T00:00:00.000Z",
  name: "agent.turn",
  phase: "start",
  data: { input: "第一条" },
};

test("断线期间的事件会在重连时补齐且不与实时事件重复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-viewer-"));
  const store = new MemoryTraceStore();
  let visibleEvents: TraceEvent[] = [];
  const feed = createViewerEventFeed({
    loadHistory: () => Promise.resolve(store.list()),
    updateEvents: (events) => {
      visibleEvents = events;
    },
    updateStatus: () => undefined,
  });

  store.emit(firstEvent);
  await feed.onOpen();
  feed.onError();

  const missedEvent: TraceEvent = {
    ...firstEvent,
    id: "event-2",
    sequence: 2,
    name: "agent.turn", phase: "end",
  };
  store.emit(missedEvent);

  await feed.onOpen();
  feed.onMessage(missedEvent);

  assert.deepEqual(visibleEvents.map((event) => event.id), ["event-1", "event-2"]);
});

test("补读历史期间到达的实时事件不会被历史结果覆盖", async () => {
  let finishHistory: ((events: TraceEvent[]) => void) | undefined;
  const history = new Promise<TraceEvent[]>((resolve) => {
    finishHistory = resolve;
  });
  let visibleEvents: TraceEvent[] = [];
  const feed = createViewerEventFeed({
    loadHistory: () => history,
    updateEvents: (events) => {
      visibleEvents = events;
    },
    updateStatus: () => undefined,
  });

  const opening = feed.onOpen();
  feed.onMessage(firstEvent);
  finishHistory?.([]);
  await opening;

  assert.deepEqual(visibleEvents.map((event) => event.id), [firstEvent.id]);
});

test("多个 session 按首次时间排序并在 session 内按 sequence 排序", () => {
  const events: TraceEvent[] = [
    firstEvent,
    {
      ...firstEvent,
      id: "session-1-event-2",
      sequence: 2,
      timestamp: "2026-08-12T00:02:00.000Z",
      name: "agent.turn", phase: "end",
    },
    {
      ...firstEvent,
      id: "session-2-event-1",
      traceId: "session-2",
      sequence: 1,
      timestamp: "2026-08-12T00:03:00.000Z",
    },
    {
      ...firstEvent,
      id: "session-2-event-2",
      traceId: "session-2",
      sequence: 2,
      timestamp: "2026-08-12T00:04:00.000Z",
      name: "agent.turn", phase: "end",
    },
  ];

  assert.deepEqual(
    mergeViewerEvents([], events).map((event) => event.id),
    ["event-1", "session-1-event-2", "session-2-event-1", "session-2-event-2"],
  );
});
