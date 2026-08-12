import type { TraceEvent } from "@dkagent/trace";

export interface ViewerEventFeedOptions {
  loadHistory(): Promise<TraceEvent[]>;
  updateEvents(events: TraceEvent[]): void;
  updateStatus(status: "实时连接" | "读取失败" | "重连中"): void;
}

/** 合并历史与实时事件；同一事件可能同时来自补读和 SSE。 */
export function mergeViewerEvents(
  current: TraceEvent[],
  incoming: TraceEvent[],
): TraceEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  const events = [...byId.values()];
  const eventOrder = new Map(events.map((event, index) => [event.id, index]));
  const sessions = new Map<string, { firstTimestamp: number; firstIndex: number }>();

  for (const [index, event] of events.entries()) {
    const parsedTimestamp = Date.parse(event.timestamp);
    const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Number.POSITIVE_INFINITY;
    const session = sessions.get(event.traceId);
    if (!session) {
      sessions.set(event.traceId, { firstTimestamp: timestamp, firstIndex: index });
    } else if (timestamp < session.firstTimestamp) {
      session.firstTimestamp = timestamp;
    }
  }

  return events.sort((left, right) => {
    const leftSession = sessions.get(left.traceId)!;
    const rightSession = sessions.get(right.traceId)!;
    if (leftSession !== rightSession) {
      return leftSession.firstTimestamp - rightSession.firstTimestamp
        || leftSession.firstIndex - rightSession.firstIndex;
    }
    return left.sequence - right.sequence
      || Date.parse(left.timestamp) - Date.parse(right.timestamp)
      || eventOrder.get(left.id)! - eventOrder.get(right.id)!;
  });
}

/** 封装 EventSource 生命周期，保证每次连接成功都补读持久化历史。 */
export function createViewerEventFeed(options: ViewerEventFeedOptions): {
  onOpen(): Promise<void>;
  onMessage(event: TraceEvent): void;
  onError(): void;
} {
  let events: TraceEvent[] = [];

  return {
    async onOpen(): Promise<void> {
      options.updateStatus("实时连接");
      try {
        const history = await options.loadHistory();
        // await 期间可能收到 SSE；此处必须读取最新 events 再合并。
        events = mergeViewerEvents(events, history);
        options.updateEvents(events);
      } catch {
        options.updateStatus("读取失败");
      }
    },
    onMessage(event: TraceEvent): void {
      events = mergeViewerEvents(events, [event]);
      options.updateEvents(events);
    },
    onError(): void {
      options.updateStatus("重连中");
    },
  };
}
