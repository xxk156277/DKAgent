import type { TraceEvent } from "@dkagent/trace";
import type { StoreApi } from "zustand/vanilla";
import type { TapState } from "../store/tap-store.js";

interface EventSourceLike {
    onopen: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: ((event: Event) => void) | null;
    close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;
type FetchEvents = (url: string) => Promise<{ json(): Promise<TraceEvent[]> }>;
const connectionEpochs = new WeakMap<StoreApi<TapState>, number>();

export interface EventFeedOptions {
    sessionId?: string;
    fetch?: FetchEvents;
    EventSource?: EventSourceConstructor;
}

/** 连接历史快照与 SSE；Store 合并事件，避免请求窗口内丢失实时事件。 */
export function connectEventFeed(store: StoreApi<TapState>, options: EventFeedOptions = {}): () => void {
    const fetchEvents = options.fetch ?? ((url: string) => globalThis.fetch(url));
    const EventSourceImpl = options.EventSource ?? (globalThis.EventSource as unknown as EventSourceConstructor);
    const historyUrl = options.sessionId
        ? `/api/sessions/${encodeURIComponent(options.sessionId)}/events`
        : "/api/events";
    const connectionEpoch = (connectionEpochs.get(store) ?? 0) + 1;
    connectionEpochs.set(store, connectionEpoch);
    if (!EventSourceImpl) {
        store.getState().setConnectionStatus("error");
        return () => {};
    }

    let active = true;
    let requestEpoch = 0;
    const isCurrentConnection = () => active && connectionEpochs.get(store) === connectionEpoch;
    const loadHistory = async (): Promise<void> => {
        const currentRequest = ++requestEpoch;
        try {
            const response = await fetchEvents(historyUrl);
            const events = await response.json();
            // 同一连接的历史快照都可按事件 ID 合并；不能因后续请求已开始而丢弃完整历史。
            if (isCurrentConnection()) {
                store.getState().replaceHistory(events);
            }
        } catch {
            if (isCurrentConnection() && currentRequest === requestEpoch) {
                store.getState().setConnectionStatus("error");
            }
        }
    };

    store.getState().setConnectionStatus("connecting");
    const source = new EventSourceImpl("/api/events/stream");
    source.onopen = () => {
        if (!isCurrentConnection()) return;
        store.getState().setConnectionStatus("live");
        void loadHistory();
    };
    source.onmessage = (message) => {
        if (!isCurrentConnection()) return;
        try {
            const event = JSON.parse(message.data) as TraceEvent;
            if (!options.sessionId || event.sessionId === options.sessionId) {
                store.getState().appendEvent(event);
            }
        } catch {
            store.getState().setConnectionStatus("error");
        }
    };
    source.onerror = () => {
        if (isCurrentConnection()) store.getState().setConnectionStatus("reconnecting");
    };

    // 初次连接也补读持久化历史。
    void loadHistory();

    return () => {
        active = false;
        if (connectionEpochs.get(store) === connectionEpoch) {
            connectionEpochs.set(store, connectionEpoch + 1);
        }
        source.close();
    };
}
