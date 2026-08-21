export type TracePhase = "start" | "event" | "end" | "error";

/** Trace 使用英文技术名；中文显示由 Tap 负责。 */
export type TraceModule =
  | "agent"
  | "context"
  | "memory"
  | "skill"
  | "tool"
  | "model"
  | "session"
  | "artifact";

/** Trace 使用英文技术名；中文显示由 Tap 负责。 */
export type TraceEventName =
  | "agent.turn"
  | "agent.step"
  | "context.build"
  | "context.snapshot.created"
  | "context.tokens.counted"
  | "context.threshold.checked"
  | "context.compaction.planned"
  | "context.summary.request"
  | "context.summary.response"
  | "context.compaction.completed"
  | "model.request"
  | "model.response"
  | "tool.call"
  | "tool.result"
  | "memory.recall"
  | "memory.extract"
  | "memory.write"
  | "skill.run"
  | "skill.stage"
  | "artifact.created"
  | "artifact.resolved";

export interface TraceEvent<TData = unknown> {
  sessionId?: string;
  module?: TraceModule;
  operation?: string;
  id: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  sequence: number;
  timestamp: string;
  durationMs?: number;
  name: TraceEventName;
  phase: TracePhase;
  step?: number;
  data: TData;
}

export type TraceListener = (event: TraceEvent) => void | Promise<void>;

/** 被动观测出口；实现失败不得影响 Agent。 */
export interface TraceSink {
  emit(event: TraceEvent): void | Promise<void>;
}

export interface TraceStore extends TraceSink {
  list(): TraceEvent[];
  subscribe(listener: TraceListener): () => void;
}

export interface TraceEventOptions {
  step?: number;
  module?: TraceModule;
  operation?: string;
}

export interface TraceSpan {
  event(name: TraceEventName, data: unknown, options?: TraceEventOptions): void;
  setOutput(output: unknown): void;
}

export type TraceOperation<T> = (span: TraceSpan) => T | Promise<T>;
