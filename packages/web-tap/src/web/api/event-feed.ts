import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import type { StoreApi } from "zustand/vanilla";
import type { TapState } from "../store/tap-store.js";

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;
type FetchEvents = (url: string) => Promise<{ json(): Promise<RuntimeEvent[]> }>;

export interface EventFeedOptions {
  fetch?: FetchEvents;
  EventSource?: EventSourceConstructor;
}

/** 连接历史快照与 SSE；Store 合并事件，避免请求窗口内丢失实时事件。 */
export function connectEventFeed(
  store: StoreApi<TapState>,
  options: EventFeedOptions = {},
): () => void {
  const fetchEvents = options.fetch ?? ((url: string) => globalThis.fetch(url));
  const EventSourceImpl = options.EventSource ?? globalThis.EventSource as unknown as EventSourceConstructor;
  if (!EventSourceImpl) {
    store.getState().setConnectionStatus("error");
    return () => {};
  }

  let active = true;
  const loadHistory = async (): Promise<void> => {
    try {
      const response = await fetchEvents("/api/events");
      const events = await response.json();
      if (active) store.getState().replaceHistory(events);
    } catch {
      if (active) store.getState().setConnectionStatus("error");
    }
  };

  store.getState().setConnectionStatus("connecting");
  const source = new EventSourceImpl("/api/events/stream");
  source.onopen = () => {
    store.getState().setConnectionStatus("live");
    void loadHistory();
  };
  source.onmessage = (message) => {
    if (!active) return;
    try {
      store.getState().appendEvent(JSON.parse(message.data) as RuntimeEvent);
    } catch {
      store.getState().setConnectionStatus("error");
    }
  };
  source.onerror = () => {
    if (active) store.getState().setConnectionStatus("reconnecting");
  };

  // 初次连接也补读持久化历史。
  void loadHistory();

  return () => {
    active = false;
    source.close();
  };
}
