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

export type ToolProtocolViolationKind =
  | "unpaired-call"
  | "orphan-result"
  | "duplicate-call-id"
  | "duplicate-result-id"
  | "tool-name-mismatch";

export interface ToolProtocolViolation {
  kind: ToolProtocolViolationKind;
  id: string;
  message: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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
  const calls = selectToolCalls(events);
  const results = selectToolResults(events);
  const resultIds = new Set(results.map((item) => item.toolCallId));
  return [...new Set(calls
    .filter((call) => !resultIds.has(call.id))
    .map((call) => call.id))];
}

export function findToolProtocolViolations(
  events: readonly TraceEvent[],
): ToolProtocolViolation[] {
  const calls = selectToolCalls(events);
  const results = selectToolResults(events);
  const callsById = new Map<string, EvalToolCall[]>();
  const resultsById = new Map<string, EvalToolResult[]>();

  for (const call of calls) {
    const items = callsById.get(call.id) ?? [];
    items.push(call);
    callsById.set(call.id, items);
  }
  for (const result of results) {
    const items = resultsById.get(result.toolCallId) ?? [];
    items.push(result);
    resultsById.set(result.toolCallId, items);
  }

  const violations: ToolProtocolViolation[] = [];
  for (const [id, items] of callsById) {
    if (items.length > 1) {
      violations.push({
        kind: "duplicate-call-id",
        id,
        message: `重复 Tool Call ID: ${id} (${items.length} 次)`,
      });
    }
  }
  for (const [id, items] of resultsById) {
    if (items.length > 1) {
      violations.push({
        kind: "duplicate-result-id",
        id,
        message: `重复 Tool Result ID: ${id} (${items.length} 次)`,
      });
    }
  }
  for (const [id, items] of resultsById) {
    if (!callsById.has(id)) {
      violations.push({
        kind: "orphan-result",
        id,
        message: `孤立 Tool Result，无对应 Call: ${id}`,
      });
    }
  }
  for (const [id, items] of callsById) {
    if (!resultsById.has(id)) {
      violations.push({
        kind: "unpaired-call",
        id,
        message: `孤立 Tool Call，无对应 Result: ${id}`,
      });
    }
  }
  for (const [id, callItems] of callsById) {
    const resultItems = resultsById.get(id);
    if (!resultItems) continue;
    const callNames = new Set(callItems.map((call) => call.name));
    const resultNames = new Set(resultItems.map((result) => result.name));
    if ([...callNames].some((name) => !resultNames.has(name))
      || [...resultNames].some((name) => !callNames.has(name))) {
      violations.push({
        kind: "tool-name-mismatch",
        id,
        message: `Tool 名称不一致 (${id}): Call=${[...callNames].join(", ")}, Result=${[...resultNames].join(", ")}`,
      });
    }
  }
  return violations;
}

export function hasNormalTermination(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.name === "agent.turn" && event.phase === "end")
    && !events.some((event) => event.name === "agent.turn" && event.phase === "error");
}
