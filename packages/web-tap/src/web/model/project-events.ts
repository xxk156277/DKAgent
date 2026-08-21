import type { TraceEvent } from "@dkagent/trace";
import { createContextDiff } from "./context-diff.js";
import type {
  TapModuleKind,
  TapNodeKind,
  TapNodeView,
  TapSessionView,
  TapStepView,
  TapTurnView,
} from "./types.js";

/** 将 Trace 投影为当前详情页需要的 Session → Turn → Step → Node。 */
export function projectEvents(events: TraceEvent[]): TapSessionView[] {
  const sessions: TapSessionView[] = [];
  const sessionMap = new Map<string, TapSessionView>();
  const turns = new Map<string, TapTurnView>();
  const stepMaps = new Map<string, Map<number, TapStepView>>();
  const latestSteps = new Map<string, number>();
  const contextBefore = new Map<string, TraceEvent>();

  for (const event of sortEvents(events)) {
    const sessionId = event.sessionId ?? "unlinked";
    const session = getSession(sessionMap, sessions, sessionId);
    const turnKey = `${sessionId}:${event.traceId}`;
    const turn = getTurn(turns, session, turnKey, event.traceId);
    turn.rawEvents.push(event);
    const stepNumber = resolveStep(event, latestSteps.get(turnKey));
    latestSteps.set(turnKey, Math.max(latestSteps.get(turnKey) ?? 1, stepNumber));
    const step = getStep(stepMaps, turnKey, turn, stepNumber);

    if (event.name === "context.build" && event.phase === "start") {
      contextBefore.set(`${turnKey}:${stepNumber}`, event);
    }
    const nodes = toNodes(event, stepNumber, contextBefore.get(`${turnKey}:${stepNumber}`));
    step.nodes.push(...nodes);
  }

  return sessions;
}

function toNodes(event: TraceEvent, step: number, before?: TraceEvent): TapNodeView[] {
  if (shouldHideLifecycleEnd(event)) return [];

  // 兼容迁移前测试夹具；真实 Trace 中请求与响应已是两个独立事件。
  if (event.name === "model.response" && isRecord(event.data)
    && "request" in event.data && "response" in event.data) {
    return [
      eventNode(event, step, "model_request", "模型请求", "running", event.data.request),
      eventNode(event, step, "model_response", "模型响应", "completed", event.data.response),
    ];
  }

  if (event.name === "context.snapshot.created") {
    const payload = unwrapData(event.data);
    const after = eventNode(event, step, "context_after", "Context 已构建", "completed", payload);
    const dropped = readNumber(payload, "metrics", "droppedMessageCount");
    return dropped > 0 && before
      ? [derivedTrimNode(before, event, step), after]
      : [after];
  }

  const definition = nodeDefinition(event);
  return [eventNode(
    event,
    step,
    definition.kind,
    definition.title,
    definition.status,
    unwrapData(event.data),
  )];
}

function shouldHideLifecycleEnd(event: TraceEvent): boolean {
  if (event.phase !== "end") return false;
  return event.name === "agent.step"
    || event.name === "context.build"
    || event.name === "context.summary.request"
    || event.name === "model.request"
    || event.name === "tool.call";
}

function nodeDefinition(event: TraceEvent): {
  kind: TapNodeKind;
  title: string;
  status: TapNodeView["status"];
} {
  if (event.name === "memory.recall") {
    return operationDefinition("memory_operation", event, "召回记忆");
  }
  if (event.name === "memory.extract") {
    return operationDefinition("memory_operation", event, "提取记忆");
  }
  if (event.name === "memory.write") {
    return operationDefinition("memory_operation", event, "写入记忆");
  }
  if (event.name === "skill.run" || event.name === "skill.stage") {
    return operationDefinition("skill_operation", event, operationLabel(event.operation) ?? "技能操作");
  }
  if (event.name === "artifact.created") {
    return { kind: "artifact_operation", title: "创建产物", status: "completed" };
  }
  if (event.name === "artifact.resolved") {
    return { kind: "artifact_operation", title: "读取产物", status: "completed" };
  }
  if (event.phase === "error") {
    return {
      kind: event.name === "agent.turn" ? "turn_error" : "unknown",
      title: event.name === "agent.turn" ? "对话失败" : `${eventLabel(event.name)}失败`,
      status: "error",
    };
  }
  switch (event.name) {
    case "agent.turn":
      return event.phase === "start"
        ? { kind: "turn_start", title: "对话开始", status: "running" }
        : { kind: "turn_end", title: "对话完成", status: "completed" };
    case "agent.step": return { kind: "step_start", title: `Step ${event.step ?? 1} 开始`, status: "running" };
    case "context.build": return { kind: "context_before", title: "构建 Context", status: "running" };
    case "context.tokens.counted": return { kind: "context_tokens", title: tokenStageLabel(event.data), status: "completed" };
    case "context.threshold.checked": return { kind: "context_threshold", title: "检查压缩阈值", status: "completed" };
    case "context.compaction.planned": return { kind: "context_compaction_plan", title: "规划 Context 压缩", status: "completed" };
    case "context.summary.request": return { kind: "context_summary_request", title: "摘要模型请求", status: "running" };
    case "context.summary.response": return { kind: "context_summary_response", title: "摘要模型响应", status: "completed" };
    case "context.compaction.completed": return { kind: "context_compaction_completed", title: "Context 压缩完成", status: "completed" };
    case "model.request": return { kind: "model_request", title: modelTitle(event, "请求"), status: "running" };
    case "model.response": return { kind: "model_response", title: modelTitle(event, "响应"), status: "completed" };
    case "tool.call": return { kind: "tool_call", title: "Tool 调用", status: "running" };
    case "tool.result": return { kind: "tool_result", title: "Tool 结果", status: "completed" };
    default: return { kind: "unknown", title: "未知事件", status: "completed" };
  }
}

function operationDefinition(
  kind: Extract<TapNodeKind, "memory_operation" | "skill_operation">,
  event: TraceEvent,
  title: string,
): { kind: TapNodeKind; title: string; status: TapNodeView["status"] } {
  if (event.phase === "start") return { kind, title, status: "running" };
  if (event.phase === "error") return { kind, title: `${title}失败`, status: "error" };
  return {
    kind,
    title: `${title}${event.phase === "event" ? "结果" : "完成"}`,
    status: "completed",
  };
}

const operationLabels: Record<string, string> = {
  recall: "召回记忆",
  extract: "提取记忆",
  write: "写入记忆",
  persist: "持久化记忆",
  "diagnose-transcript": "分析面试记录",
  read_transcript: "读取并解析面试稿",
  preprocess_transcript: "纠错预处理",
  structure_interview: "构建问答结构",
  extract_project_facts: "提取项目事实",
  analyze_expression: "分析表达",
  retrieve_reference: "检索参考资料",
  analyze_answer: "分析回答",
  generate_report: "生成分析报告",
  generate_report_summary: "生成报告总结",
  evaluate_job_match: "分析岗位匹配",
  write_report: "写入分析报告",
};

function operationLabel(operation: string | undefined): string | undefined {
  return operation === undefined ? undefined : operationLabels[operation] ?? operation;
}

function modelTitle(event: TraceEvent, phase: "请求" | "响应"): string {
  const operation = event.module === "memory" || event.module === "skill"
    ? operationLabel(event.operation)
    : undefined;
  return operation ? `${operation} · 模型${phase}` : `模型${phase}`;
}

function derivedTrimNode(before: TraceEvent, after: TraceEvent, step: number): TapNodeView {
  const beforeData = unwrapData(before.data);
  const afterData = unwrapData(after.data);
  const afterContext = isRecord(afterData) && "context" in afterData
    ? afterData.context
    : afterData;
  return {
    id: `${after.traceId}:${step}:context_trimmed:${before.id}:${after.id}`,
    kind: "context_trimmed",
    module: "context",
    title: "上下文已裁剪",
    eventType: "context.trimmed",
    status: "completed",
    eventIds: [before.id, after.id],
    detail: createContextDiff(beforeData, afterContext),
    rawEvents: [before, after],
  };
}

function eventNode(
  event: TraceEvent,
  step: number,
  kind: TapNodeKind,
  title: string,
  status: TapNodeView["status"],
  detail: unknown,
): TapNodeView {
  return {
    id: `${event.traceId}:${step}:${kind}:${event.id}`,
    kind,
    module: moduleForTraceEvent(event),
    title,
    eventType: `${event.name}.${event.phase}`,
    status,
    eventIds: [event.id],
    detail: kind === "unknown" ? { raw: event } : detail,
    rawEvents: [event],
  };
}

/** 模块归属只服务于 Tap 展示，不进入 Agent 或 Trace 契约。 */
export function moduleForEvent(eventName: string): TapModuleKind {
  const prefix = eventName.split(".", 1)[0];
  if (prefix === "session" || prefix === "context" || prefix === "memory"
    || prefix === "skill" || prefix === "artifact" || prefix === "tool"
    || prefix === "model" || prefix === "agent") {
    return prefix;
  }
  return "other";
}

/** 新版 Trace 显式模块优先，旧 Trace 继续按事件名前缀兼容。 */
export function moduleForTraceEvent(event: TraceEvent): TapModuleKind {
  return event.module ?? moduleForEvent(event.name);
}

function unwrapData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (Object.keys(data).length === 1 && "input" in data) return data.input;
  if (Object.keys(data).length === 1 && "output" in data) return data.output;
  return data;
}

function tokenStageLabel(data: unknown): string {
  const value = unwrapData(data);
  const stage = isRecord(value) ? value.stage : undefined;
  if (stage === "before_compaction") return "计算压缩前 Token";
  if (stage === "after_compaction") return "计算压缩后 Token";
  if (stage === "final_request") return "计算最终请求 Token";
  return "计算 Token";
}

function eventLabel(name: string): string {
  return name.split(".").map((word) => ({
    agent: "Agent",
    context: "Context",
    summary: "摘要",
    model: "模型",
    tool: "Tool",
    request: "请求",
  })[word] ?? word).join(" ");
}

function resolveStep(event: TraceEvent, latestStep?: number): number {
  return event.step ?? latestStep ?? 1;
}

function getSession(
  sessionMap: Map<string, TapSessionView>,
  sessions: TapSessionView[],
  sessionId: string,
): TapSessionView {
  const existing = sessionMap.get(sessionId);
  if (existing) return existing;
  const session = { id: sessionId, turns: [] };
  sessionMap.set(sessionId, session);
  sessions.push(session);
  return session;
}

function getTurn(
  turns: Map<string, TapTurnView>,
  session: TapSessionView,
  turnKey: string,
  traceId: string,
): TapTurnView {
  const existing = turns.get(turnKey);
  if (existing) return existing;
  const turn: TapTurnView = { id: traceId, steps: [], rawEvents: [] };
  turns.set(turnKey, turn);
  session.turns.push(turn);
  return turn;
}

function getStep(
  stepMaps: Map<string, Map<number, TapStepView>>,
  traceId: string,
  turn: TapTurnView,
  stepNumber: number,
): TapStepView {
  let steps = stepMaps.get(traceId);
  if (!steps) {
    steps = new Map();
    stepMaps.set(traceId, steps);
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

function sortEvents(events: TraceEvent[]): TraceEvent[] {
  const order = new Map(events.map((event, index) => [event.id, index]));
  return [...events].sort((left, right) => left.sequence - right.sequence
    || Date.parse(left.timestamp) - Date.parse(right.timestamp)
    || (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

function readNumber(value: unknown, parentKey: string, key: string): number {
  if (!isRecord(value) || !isRecord(value[parentKey])) return 0;
  const number = value[parentKey][key];
  return typeof number === "number" ? number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
