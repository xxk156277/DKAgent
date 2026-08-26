import type { TraceEvent } from "@dkagent/trace";

export interface EvalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sequence: number;
  step?: number;
}

export interface EvalToolResult {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result: {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  sequence: number;
  step?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function selectToolCalls(events: readonly TraceEvent[]): EvalToolCall[] {
  return events.flatMap((traceEvent) => {
    if (traceEvent.name !== "tool.call" || traceEvent.phase !== "start") return [];
    const call = record(record(traceEvent.data)?.input);
    const input = record(call?.input);
    if (typeof call?.id !== "string" || typeof call.name !== "string" || !input) return [];
    return [{
      id: call.id,
      name: call.name,
      input,
      sequence: traceEvent.sequence,
      ...(traceEvent.step === undefined ? {} : { step: traceEvent.step }),
    }];
  });
}

export function selectToolResults(events: readonly TraceEvent[]): EvalToolResult[] {
  return events.flatMap((traceEvent) => {
    if (traceEvent.name !== "tool.result" || traceEvent.phase !== "event") return [];
    const dispatched = record(traceEvent.data);
    const input = record(dispatched?.input);
    const result = record(dispatched?.result);
    if (
      typeof dispatched?.toolCallId !== "string"
      || typeof dispatched.name !== "string"
      || !input
      || typeof result?.success !== "boolean"
    ) return [];
    return [{
      toolCallId: dispatched.toolCallId,
      name: dispatched.name,
      input,
      result: result as EvalToolResult["result"],
      sequence: traceEvent.sequence,
      ...(traceEvent.step === undefined ? {} : { step: traceEvent.step }),
    }];
  });
}

export function findUnpairedToolCallIds(events: readonly TraceEvent[]): string[] {
  const resultIds = new Set(selectToolResults(events).map((item) => item.toolCallId));
  return selectToolCalls(events)
    .filter((call) => !resultIds.has(call.id))
    .map((call) => call.id);
}

export function hasNormalTermination(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.name === "agent.turn" && event.phase === "end")
    && !events.some((event) => event.name === "agent.turn" && event.phase === "error");
}
