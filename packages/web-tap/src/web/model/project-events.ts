import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { createContextDiff } from "./context-diff.js";
import type { TapNodeKind, TapNodeView, TapSessionView, TapStepView, TapTurnView } from "./types.js";

/** 将不可变 Runtime Events 投影为 UI 消费的 Session → Turn → Step → Node。 */
export function projectEvents(events: RuntimeEvent[]): TapSessionView[] {
  const sorted = sortEvents(events);
  const sessions = new Map<string, TapSessionView>();
  const turns = new Map<string, TapTurnView>();
  const stepMaps = new Map<string, Map<number, TapStepView>>();
  const latestSteps = new Map<string, number>();
  const contextBefore = new Map<string, RuntimeEvent>();

  for (const event of sorted) {
    const turnKey = `${event.sessionId}:${event.turnId}`;
    const session = getSession(sessions, event.sessionId);
    const turn = getTurn(turns, session, event.turnId);
    const stepNumber = resolveStep(event, latestSteps.get(turnKey));
    latestSteps.set(turnKey, Math.max(latestSteps.get(turnKey) ?? 1, stepNumber));
    const step = getStep(stepMaps, turnKey, turn, stepNumber);
    const nodes = toNodes(event, stepNumber, contextBefore.get(`${turnKey}:${stepNumber}`));
    step.nodes.push(...nodes);

    if (event.type === "context.before") contextBefore.set(`${turnKey}:${stepNumber}`, event);
  }

  return [...sessions.values()];
}

function toNodes(event: RuntimeEvent, step: number, before?: RuntimeEvent): TapNodeView[] {
  if (event.type === "model.response") return modelNodes(event, step);

  if (event.type === "context.after") {
    const after = eventNode(event, step, "context_after", "Context 已构建", "completed", {
      context: event.payload,
      diff: before ? createContextDiff(before.payload, event.payload) : undefined,
    });
    if (droppedMessageCount(event.payload) > 0 && before) {
      return [
        derivedTrimNode(before, event, step),
        after,
      ];
    }
    return [after];
  }

  const mapped = nodeDefinition(event.type);
  return [eventNode(event, step, mapped.kind, mapped.title, mapped.status, event.payload)];
}

function modelNodes(event: RuntimeEvent, step: number): TapNodeView[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  return [
    eventNode(event, step, "model_request", "模型请求", "running", payload.request, ":request"),
    eventNode(event, step, "model_response", "模型响应", "completed", payload.response, ":response"),
  ];
}

function derivedTrimNode(before: RuntimeEvent, after: RuntimeEvent, step: number): TapNodeView {
  return {
    id: `${after.turnId}:${step}:context_trimmed:${before.id}:${after.id}`,
    kind: "context_trimmed",
    title: "上下文已裁剪",
    eventType: "context.trimmed",
    status: "completed",
    eventIds: [before.id, after.id],
    detail: createContextDiff(before.payload, after.payload),
    rawEvents: [before, after],
  };
}

function eventNode(
  event: RuntimeEvent,
  step: number,
  kind: TapNodeKind,
  title: string,
  status: TapNodeView["status"],
  detail: unknown,
  suffix = "",
): TapNodeView {
  return {
    id: `${event.turnId}:${step}:${kind}:${event.id}${suffix}`,
    kind,
    title,
    eventType: event.type,
    status,
    eventIds: [event.id],
    detail: kind === "unknown" ? { raw: event } : detail,
    rawEvents: [event],
  };
}

function nodeDefinition(type: string): { kind: TapNodeKind; title: string; status: TapNodeView["status"] } {
  switch (type) {
    case "turn.start": return { kind: "turn_start", title: "对话开始", status: "running" };
    case "context.before": return { kind: "context_before", title: "构建 Context 前", status: "running" };
    case "tool.call": return { kind: "tool_call", title: "Tool 调用", status: "running" };
    case "tool.result": return { kind: "tool_result", title: "Tool 结果", status: "completed" };
    case "turn.end": return { kind: "turn_end", title: "对话完成", status: "completed" };
    case "turn.error": return { kind: "turn_error", title: "对话失败", status: "error" };
    default: return { kind: "unknown", title: "未知事件", status: "completed" };
  }
}

function resolveStep(event: RuntimeEvent, latestStep?: number): number {
  if (event.type === "turn.start") return 1;
  if ((event.type === "turn.end" || event.type === "turn.error") && event.step === undefined) {
    return latestStep ?? 1;
  }
  return typeof event.step === "number" && Number.isFinite(event.step) ? event.step : 1;
}

function getSession(sessions: Map<string, TapSessionView>, sessionId: string): TapSessionView {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const session = { id: sessionId, turns: [] };
  sessions.set(sessionId, session);
  return session;
}

function getTurn(turns: Map<string, TapTurnView>, session: TapSessionView, turnId: string): TapTurnView {
  const key = `${session.id}:${turnId}`;
  const existing = turns.get(key);
  if (existing) return existing;
  const turn = { id: turnId, steps: [] };
  turns.set(key, turn);
  session.turns.push(turn);
  return turn;
}

function getStep(
  stepMaps: Map<string, Map<number, TapStepView>>,
  turnKey: string,
  turn: TapTurnView,
  stepNumber: number,
): TapStepView {
  let steps = stepMaps.get(turnKey);
  if (!steps) {
    steps = new Map();
    stepMaps.set(turnKey, steps);
  }
  const existing = steps.get(stepNumber);
  if (existing) return existing;
  const step = { step: stepNumber, nodes: [] };
  steps.set(stepNumber, step);
  const index = turn.steps.findIndex((item) => item.step > stepNumber);
  if (index < 0) turn.steps.push(step);
  else turn.steps.splice(index, 0, step);
  return step;
}

function sortEvents(events: RuntimeEvent[]): RuntimeEvent[] {
  const insertionOrder = new Map(events.map((event, index) => [event.id, index]));
  const sessions = new Map<string, { timestamp: number; index: number }>();
  for (const [index, event] of events.entries()) {
    const timestamp = parsedTimestamp(event.timestamp);
    const current = sessions.get(event.sessionId);
    if (!current || timestamp < current.timestamp) sessions.set(event.sessionId, { timestamp, index });
  }
  return [...events].sort((left, right) => {
    const leftSession = sessions.get(left.sessionId)!;
    const rightSession = sessions.get(right.sessionId)!;
    if (leftSession !== rightSession) return leftSession.timestamp - rightSession.timestamp || leftSession.index - rightSession.index;
    return left.sequence - right.sequence
      || parsedTimestamp(left.timestamp) - parsedTimestamp(right.timestamp)
      || (insertionOrder.get(left.id) ?? 0) - (insertionOrder.get(right.id) ?? 0);
  });
}

function parsedTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function droppedMessageCount(payload: unknown): number {
  return isRecord(payload) && typeof payload.droppedMessageCount === "number" ? payload.droppedMessageCount : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
