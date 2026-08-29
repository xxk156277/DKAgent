import type { AnyTraceSpan, TraceDocument, TraceTokenUsage } from "@dkagent/trace";
import type { TapModuleKind, TapNodeView, TapStepView, TapTurnView } from "./types.js";

export function projectSpans(document: TraceDocument): TapTurnView {
  const spans = [...document.spans].sort((left, right) => left.sequence - right.sequence);
  const spansById = new Map(spans.map((span) => [span.spanId, span]));
  const childrenByParent = indexChildren(spans);
  const groups = new Map<number | "turn", TapNodeView[]>();

  for (const span of spans) {
    const group = findStep(span, spansById);
    const nodes = groups.get(group) ?? [];
    nodes.push(toNode(span, document, childrenByParent));
    groups.set(group, nodes);
  }

  const steps: TapStepView[] = [...groups.entries()]
    .map(([step, nodes]) => ({ step, nodes }))
    .sort((left, right) => firstSequence(left) - firstSequence(right));
  return {
    id: document.trace.traceId,
    trace: document.trace,
    complete: document.complete,
    diagnostics: document.diagnostics,
    steps,
    rawSpans: spans,
  };
}

function toNode(
  span: AnyTraceSpan,
  document: TraceDocument,
  childrenByParent: Map<string, AnyTraceSpan[]>,
): TapNodeView {
  const selfDuration = selfDurationMs(span, childrenByParent.get(span.spanId) ?? []);
  return {
    id: span.spanId,
    kind: span.name,
    module: moduleForSpan(span),
    title: titleForSpan(span),
    eventType: span.name,
    status: span.status === "ok" ? "completed" : span.status,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    sequence: span.sequence,
    revision: span.revision,
    directTokenUsage: span.tokenUsage,
    subtreeTokenUsage: subtreeTokenUsage(span, childrenByParent),
    ...(span.durationMs === undefined ? {} : { durationMs: span.durationMs }),
    ...(selfDuration === undefined ? {} : { selfDurationMs: selfDuration }),
    integrityWarnings: warningsFor(span, document),
    detail: {
      input: span.input,
      output: span.output,
      ...(span.error === undefined ? {} : { error: span.error }),
      events: span.events,
      attributes: span.attributes,
      integrity: span.integrity,
    },
    rawSpans: [span],
  };
}

function findStep(span: AnyTraceSpan, spansById: Map<string, AnyTraceSpan>): number | "turn" {
  let current: AnyTraceSpan | undefined = span;
  while (current) {
    if (current.name === "agent.step") return current.input.step;
    current = current.parentSpanId === undefined ? undefined : spansById.get(current.parentSpanId);
  }
  return "turn";
}

function indexChildren(spans: AnyTraceSpan[]): Map<string, AnyTraceSpan[]> {
  const result = new Map<string, AnyTraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined) continue;
    const children = result.get(span.parentSpanId) ?? [];
    children.push(span);
    result.set(span.parentSpanId, children);
  }
  return result;
}

function subtreeTokenUsage(span: AnyTraceSpan, childrenByParent: Map<string, AnyTraceSpan[]>): TraceTokenUsage | null {
  const usages: TraceTokenUsage[] = [];
  const visit = (current: AnyTraceSpan): void => {
    if (current.name === "model.generate" && current.tokenUsage) usages.push(current.tokenUsage);
    for (const child of childrenByParent.get(current.spanId) ?? []) visit(child);
  };
  visit(span);
  if (usages.length === 0) return null;
  return usages.reduce<TraceTokenUsage>((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    ...sumOptionalToken(total, usage, "cacheReadTokens"),
    ...sumOptionalToken(total, usage, "cacheWriteTokens"),
  }), { inputTokens: 0, outputTokens: 0 });
}

function sumOptionalToken(
  total: TraceTokenUsage,
  usage: TraceTokenUsage,
  key: "cacheReadTokens" | "cacheWriteTokens",
): Partial<TraceTokenUsage> {
  const next = (total[key] ?? 0) + (usage[key] ?? 0);
  return next === 0 && total[key] === undefined && usage[key] === undefined ? {} : { [key]: next };
}

function selfDurationMs(span: AnyTraceSpan, children: AnyTraceSpan[]): number | undefined {
  if (span.status === "running" || span.durationMs === undefined || span.endedAt === undefined) return undefined;
  const parentStart = Date.parse(span.startedAt);
  const parentEnd = Date.parse(span.endedAt);
  if (!Number.isFinite(parentStart) || !Number.isFinite(parentEnd) || parentEnd < parentStart) return undefined;
  const intervals = children.flatMap((child): Array<[number, number]> => {
    if (child.endedAt === undefined) return [];
    const start = Math.max(parentStart, Date.parse(child.startedAt));
    const end = Math.min(parentEnd, Date.parse(child.endedAt));
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? [[start, end]] : [];
  }).sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let current: [number, number] | undefined;
  for (const interval of intervals) {
    if (!current) current = interval;
    else if (interval[0] <= current[1]) current[1] = Math.max(current[1], interval[1]);
    else {
      covered += current[1] - current[0];
      current = interval;
    }
  }
  if (current) covered += current[1] - current[0];
  return Math.max(0, span.durationMs - covered);
}

function warningsFor(span: AnyTraceSpan, document: TraceDocument): string[] {
  const warnings: string[] = [];
  if (document.diagnostics.running.includes(span.spanId)) warnings.push("running");
  if (document.diagnostics.missingParent.includes(span.spanId)) warnings.push("missing_parent");
  if (document.diagnostics.outputMissing.includes(span.spanId)) warnings.push("output_missing");
  if (document.diagnostics.serializationError.includes(span.spanId)) warnings.push("serialization_error");
  if (!span.integrity) warnings.push("integrity=false");
  if (document.diagnostics.missingRoot && span.name === "agent.turn") warnings.push("missing_root");
  return warnings;
}

function moduleForSpan(span: AnyTraceSpan): TapModuleKind {
  if (span.kind === "CONTEXT") return "context";
  if (span.kind === "MEMORY") return "memory";
  if (span.kind === "ARTIFACT") return "artifact";
  if (span.kind === "TOOL") return "tool";
  if (span.kind === "LLM") return "model";
  return "agent";
}

function titleForSpan(span: AnyTraceSpan): string {
  if (span.name === "agent.turn") return "Agent Turn";
  if (span.name === "agent.step") return `Agent Step ${span.input.step}`;
  if (span.name === "tool.execute") return `Tool · ${span.input.name}`;
  if (span.name === "model.generate") return `Model · ${span.input.model}`;
  return span.name;
}

function firstSequence(group: TapStepView): number {
  return group.nodes[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
}
