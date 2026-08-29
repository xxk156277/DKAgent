import type { AnyTraceSpan, SpanChange, TraceDocument, TraceSummary } from "@dkagent/trace";
import { describe, expect, it, vi } from "vitest";
import { connectTraceFeed } from "../../src/web/api/trace-feed.js";
import { createTapStore, selectTurns } from "../../src/web/store/tap-store.js";

function summary(traceId: string, startedAt: string): TraceSummary {
  return { traceId, sessionId: "session-1", status: "ok", startedAt, spanCount: 1, integrity: true };
}

function span(traceId = "trace-new", revision = 2): AnyTraceSpan {
  return {
    schemaVersion: 2,
    traceId,
    spanId: `root-${traceId}`,
    sessionId: "session-1",
    name: "agent.turn",
    kind: "AGENT",
    status: "ok",
    sequence: 1,
    revision,
    startedAt: traceId === "trace-new" ? "2026-08-24T00:00:02.000Z" : "2026-08-24T00:00:01.000Z",
    endedAt: "2026-08-24T00:00:03.000Z",
    durationMs: 1000,
    input: { userInput: traceId },
    output: { answer: "done" },
    tokenUsage: null,
    attributes: {},
    events: [],
    integrity: true,
  };
}

function document(value: AnyTraceSpan): TraceDocument {
  return {
    schemaVersion: 2,
    trace: summary(value.traceId, value.startedAt),
    spans: [value],
    complete: true,
    diagnostics: { missingRoot: false, missingParent: [], running: [], outputMissing: [], serializationError: [] },
  };
}

function change(value: AnyTraceSpan): SpanChange {
  return { type: "span_ended", traceId: value.traceId, span: value };
}

describe("Tap Store V2", () => {
  it("按更高 revision 合并，并拒绝 stale、equal 与身份变化", () => {
    const store = createTapStore();
    const initial = span();
    store.getState().mergeTraceDocument(document(initial));
    store.getState().appendSpanChange(change({ ...initial, revision: 1 } as AnyTraceSpan));
    store.getState().appendSpanChange(change({ ...initial, output: { answer: "equal" } } as AnyTraceSpan));
    store.getState().appendSpanChange(change({ ...initial, revision: 3, sequence: 9 } as AnyTraceSpan));
    expect(store.getState().documentsByTraceId[initial.traceId]?.spans[0]).toEqual(initial);

    const newer = { ...initial, revision: 3, output: { answer: "new" } } as AnyTraceSpan;
    store.getState().appendSpanChange(change(newer));
    expect(store.getState().documentsByTraceId[initial.traceId]?.spans[0]).toEqual(newer);
  });

  it("历史 Document 不覆盖先到达的实时 Span", () => {
    const store = createTapStore();
    const live = { ...span(), revision: 4, output: { answer: "live" } } as AnyTraceSpan;
    store.getState().appendSpanChange(change(live));
    store.getState().mergeTraceDocument(document(span()));
    expect(store.getState().documentsByTraceId[live.traceId]?.spans[0]).toEqual(live);
  });

  it("默认选择最新 Trace；历史选择暂停跟随，重新选择最新后恢复", () => {
    const store = createTapStore();
    const oldSummary = summary("trace-old", "2026-08-24T00:00:01.000Z");
    const newSummary = summary("trace-new", "2026-08-24T00:00:02.000Z");
    store.getState().setTraceSummaries([oldSummary, newSummary]);
    store.getState().mergeTraceDocument(document(span("trace-old")));
    store.getState().mergeTraceDocument(document(span("trace-new")));
    expect(store.getState().selectedTraceId).toBe("trace-new");
    expect(selectTurns(store.getState()).map((turn) => turn.id)).toEqual(["trace-new", "trace-old"]);

    store.getState().selectTrace("trace-old");
    expect(store.getState().followLive).toBe(false);
    store.getState().setTraceSummaries([summary("trace-latest", "2026-08-24T00:00:03.000Z"), newSummary, oldSummary]);
    expect(store.getState().selectedTraceId).toBe("trace-old");

    store.getState().selectTrace("trace-latest");
    expect(store.getState().followLive).toBe(true);
  });

  it("先建立 SSE，再补读 Summary 与当前 Document；重连后再次补读", async () => {
    const store = createTapStore();
    const calls: string[] = [];
    class FakeEventSource {
      static latest: FakeEventSource;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      closed = false;
      constructor(public readonly url: string) {
        calls.push(`sse:${url}`);
        FakeEventSource.latest = this;
      }
      close() { this.closed = true; }
    }
    const fetch = vi.fn(async (url: string) => {
      calls.push(`fetch:${url}`);
      const value = url.endsWith("/traces")
        ? [summary("trace-new", "2026-08-24T00:00:02.000Z"), summary("trace-old", "2026-08-24T00:00:01.000Z")]
        : document(span(url.endsWith("trace-old") ? "trace-old" : "trace-new"));
      return { ok: true, status: 200, json: async () => value };
    });

    const cleanup = connectTraceFeed(store, {
      sessionId: "session-1",
      fetch,
      EventSource: FakeEventSource,
    });
    expect(calls).toEqual(["sse:/api/traces/stream"]);
    FakeEventSource.latest.onopen?.(new Event("open"));
    await vi.waitFor(() => expect(store.getState().documentsByTraceId["trace-new"]).toBeDefined());
    expect(calls.slice(1)).toEqual([
      "fetch:/api/sessions/session-1/traces",
      "fetch:/api/traces/trace-new",
    ]);
    expect(selectTurns(store.getState()).map((turn) => turn.id)).toEqual(["trace-new", "trace-old"]);
    store.getState().selectTrace("trace-old");
    await vi.waitFor(() => expect(store.getState().documentsByTraceId["trace-old"]).toBeDefined());
    expect(calls.at(-1)).toBe("fetch:/api/traces/trace-old");

    FakeEventSource.latest.onopen?.(new Event("open"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    expect(store.getState().connectionStatus).toBe("live");
    cleanup();
    expect(FakeEventSource.latest.closed).toBe(true);
  });
});
