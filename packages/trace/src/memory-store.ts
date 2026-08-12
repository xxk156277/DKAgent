import { sanitizeTraceEvent } from "./sanitize.js";
import type { TraceEvent, TraceListener, TraceStore } from "./types.js";

/** 进程内有界 Trace Store；重启后数据自然清空。 */
export class MemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];
  private readonly listeners = new Set<TraceListener>();

  public constructor(private readonly capacity = 2_000) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("Trace Store capacity 必须是正整数");
    }
  }

  public emit(event: TraceEvent): void {
    const sanitized = sanitizeTraceEvent(event);
    this.events.push(sanitized);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }

    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(sanitized)).catch(() => {
          // 被动订阅者失败不能影响 Trace 或 Agent。
        });
      } catch {
        // 同步订阅异常同样隔离。
      }
    }
  }

  public list(): TraceEvent[] {
    return [...this.events];
  }

  public subscribe(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
