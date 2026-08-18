import type { TraceEvent } from "./types.js";

const sensitiveFieldPattern = /api[-_]?key|authorization|headers?|env(?:ironment)?/i;
const recalledMemoryBlockPattern = /<recalled_memory>[\s\S]*?<\/recalled_memory>/gu;

/** 生成历史读取与实时推送共用的安全副本。 */
export function sanitizeTraceEvent(event: TraceEvent): TraceEvent {
  try {
    const serialized = JSON.stringify(event, (key, value) =>
      sensitiveFieldPattern.test(key)
        ? "[REDACTED]"
        : typeof value === "string"
          ? value.replace(recalledMemoryBlockPattern, "[RECALLED_MEMORY_REDACTED]")
          : value,
    );
    if (serialized === undefined) throw new Error("Trace 事件无法序列化");
    return JSON.parse(serialized) as TraceEvent;
  } catch (error: unknown) {
    return {
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      ...(event.module === undefined ? {} : { module: event.module }),
      ...(event.operation === undefined ? {} : { operation: event.operation }),
      id: event.id,
      traceId: event.traceId,
      ...(event.spanId === undefined ? {} : { spanId: event.spanId }),
      ...(event.parentSpanId === undefined ? {} : { parentSpanId: event.parentSpanId }),
      sequence: event.sequence,
      timestamp: event.timestamp,
      name: event.name,
      phase: event.phase,
      ...(event.step === undefined ? {} : { step: event.step }),
      data: {
        serializationError: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
