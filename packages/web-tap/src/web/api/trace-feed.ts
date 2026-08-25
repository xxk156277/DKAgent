import type { SpanChange, TraceDocument, TraceSummary } from "@dkagent/trace";
import type { StoreApi } from "zustand/vanilla";
import type { TapState } from "../store/tap-store.js";

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;
type FetchLike = (url: string) => Promise<Pick<Response, "ok" | "status" | "json">>;
const connectionEpochs = new WeakMap<StoreApi<TapState>, number>();

export interface TraceFeedOptions {
  sessionId: string;
  fetch?: FetchLike;
  EventSource?: EventSourceConstructor;
}

/** 先建立 SSE，再从 SQLite 补读；Store 的 revision 合并负责消除竞态。 */
export function connectTraceFeed(store: StoreApi<TapState>, options: TraceFeedOptions): () => void {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const EventSourceImpl = options.EventSource ?? globalThis.EventSource as unknown as EventSourceConstructor;
  const connectionEpoch = (connectionEpochs.get(store) ?? 0) + 1;
  connectionEpochs.set(store, connectionEpoch);
  if (!EventSourceImpl) {
    store.getState().setConnectionStatus("error");
    return () => {};
  }

  let active = true;
  let loadEpoch = 0;
  let selectionEpoch = 0;
  let historySelecting = false;
  const isCurrent = () => active && connectionEpochs.get(store) === connectionEpoch;
  const loadSelectedDocument = async (traceId: string, expectedSelection: number): Promise<void> => {
    try {
      const document = await readJson<TraceDocument>(
        await fetchImpl(`/api/traces/${encodeURIComponent(traceId)}`),
      );
      if (isCurrent() && expectedSelection === selectionEpoch && store.getState().selectedTraceId === traceId) {
        store.getState().mergeTraceDocument(document);
      }
    } catch {
      if (isCurrent() && expectedSelection === selectionEpoch) store.getState().setConnectionStatus("error");
    }
  };
  const unsubscribeSelection = store.subscribe((state, previous) => {
    const traceId = state.selectedTraceId;
    if (historySelecting || traceId === null || traceId === previous.selectedTraceId || state.documentsByTraceId[traceId]) return;
    const currentSelection = ++selectionEpoch;
    void loadSelectedDocument(traceId, currentSelection);
  });
  const loadHistory = async (): Promise<void> => {
    const currentLoad = ++loadEpoch;
    try {
      const summaries = await readJson<TraceSummary[]>(
        await fetchImpl(`/api/sessions/${encodeURIComponent(options.sessionId)}/traces`),
      );
      if (!isCurrent() || currentLoad !== loadEpoch) return;
      historySelecting = true;
      store.getState().setTraceSummaries(summaries);
      historySelecting = false;
      const traceId = store.getState().selectedTraceId;
      if (!traceId) return;
      const document = await readJson<TraceDocument>(
        await fetchImpl(`/api/traces/${encodeURIComponent(traceId)}`),
      );
      if (isCurrent() && currentLoad === loadEpoch) store.getState().mergeTraceDocument(document);
    } catch {
      historySelecting = false;
      if (isCurrent() && currentLoad === loadEpoch) store.getState().setConnectionStatus("error");
    }
  };

  store.getState().setConnectionStatus("connecting");
  const source = new EventSourceImpl("/api/traces/stream");
  source.onopen = () => {
    if (!isCurrent()) return;
    store.getState().setConnectionStatus("live");
    void loadHistory();
  };
  source.onmessage = (message) => {
    if (!isCurrent()) return;
    try {
      const change = JSON.parse(message.data) as SpanChange;
      if (change.span.sessionId === options.sessionId) store.getState().appendSpanChange(change);
    } catch {
      store.getState().setConnectionStatus("error");
    }
  };
  source.onerror = () => {
    if (isCurrent()) store.getState().setConnectionStatus("reconnecting");
  };

  return () => {
    active = false;
    unsubscribeSelection();
    if (connectionEpochs.get(store) === connectionEpoch) connectionEpochs.set(store, connectionEpoch + 1);
    source.close();
  };
}

async function readJson<T>(response: Pick<Response, "ok" | "status" | "json">): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(`Tap Trace 读取失败 (${response.status})`);
  return value as T;
}
