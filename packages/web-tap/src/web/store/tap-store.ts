import type { AnyTraceSpan, SpanChange, TraceDocument, TraceSummary } from "@dkagent/trace";
import { createTraceDocument } from "@dkagent/trace/document";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { projectSpans } from "../model/project-spans.js";
import type { TapNodeView, TapTurnView } from "../model/types.js";

const emptyTurns: TapTurnView[] = [];
const emptyNodes: TapNodeView[] = [];
let cachedSummaries: TraceSummary[] | undefined;
let cachedDocuments: Record<string, TraceDocument> | undefined;
let cachedTurns = emptyTurns;
let cachedNodeDocument: TraceDocument | undefined;
let cachedNodes = emptyNodes;

export interface TapState {
  traceSummaries: TraceSummary[];
  documentsByTraceId: Record<string, TraceDocument>;
  connectionStatus: "connecting" | "live" | "reconnecting" | "error";
  selectedTraceId: string | null;
  selectedNodeId: string | null;
  followLive: boolean;
  setTraceSummaries(summaries: TraceSummary[]): void;
  mergeTraceDocument(document: TraceDocument): void;
  appendSpanChange(change: SpanChange): void;
  selectTrace(traceId: string): void;
  selectNode(nodeId: string): void;
  setConnectionStatus(status: TapState["connectionStatus"]): void;
}

export function createTapStore() {
  return createStore<TapState>()((set, get) => ({
    traceSummaries: [],
    documentsByTraceId: {},
    connectionStatus: "connecting",
    selectedTraceId: null,
    selectedNodeId: null,
    followLive: true,
    setTraceSummaries(summaries) {
      const traceSummaries = mergeSummaries(get().traceSummaries, summaries);
      const latest = traceSummaries[0]?.traceId ?? null;
      const shouldFollow = get().followLive || get().selectedTraceId === null;
      set({
        traceSummaries,
        ...(shouldFollow ? { selectedTraceId: latest, selectedNodeId: latestNodeId(get().documentsByTraceId[latest ?? ""]) } : {}),
      });
    },
    mergeTraceDocument(document) {
      const current = get().documentsByTraceId[document.trace.traceId];
      const merged = mergeDocuments(current, document);
      const documentsByTraceId = { ...get().documentsByTraceId, [document.trace.traceId]: merged };
      const traceSummaries = mergeSummaries(get().traceSummaries, [merged.trace]);
      const latest = traceSummaries[0]?.traceId ?? null;
      const selectedTraceId = get().followLive || get().selectedTraceId === null ? latest : get().selectedTraceId;
      set({
        documentsByTraceId,
        traceSummaries,
        selectedTraceId,
        ...(selectedTraceId === document.trace.traceId ? { selectedNodeId: latestNodeId(merged) } : {}),
      });
    },
    appendSpanChange(change) {
      const current = get().documentsByTraceId[change.traceId];
      const currentSpan = current?.spans.find((span) => span.spanId === change.span.spanId);
      if (currentSpan && (currentSpan.revision >= change.span.revision || !sameIdentity(currentSpan, change.span))) return;
      const spans = current
        ? [...current.spans.filter((span) => span.spanId !== change.span.spanId), change.span]
        : [change.span];
      const trace = summaryAfterChange(current?.trace, change.span, spans.length);
      get().mergeTraceDocument(createTraceDocument(trace, spans));
    },
    selectTrace(traceId) {
      if (!get().traceSummaries.some((trace) => trace.traceId === traceId)) return;
      set({
        selectedTraceId: traceId,
        selectedNodeId: latestNodeId(get().documentsByTraceId[traceId]),
        followLive: get().traceSummaries[0]?.traceId === traceId,
      });
    },
    selectNode(nodeId) {
      const document = get().documentsByTraceId[get().selectedTraceId ?? ""];
      if (document?.spans.some((span) => span.spanId === nodeId)) set({ selectedNodeId: nodeId });
    },
    setConnectionStatus(connectionStatus) {
      set({ connectionStatus });
    },
  }));
}

export const tapStore = createTapStore();

export function useTapStore<T>(selector: (state: TapState) => T): T {
  return useStore(tapStore, selector);
}

export function selectTurns(state: TapState): TapTurnView[] {
  if (cachedSummaries === state.traceSummaries && cachedDocuments === state.documentsByTraceId) return cachedTurns;
  const turns = state.traceSummaries.flatMap((summary) => {
    const document = state.documentsByTraceId[summary.traceId] ?? createTraceDocument(summary, []);
    return [projectSpans(document)];
  });
  cachedSummaries = state.traceSummaries;
  cachedDocuments = state.documentsByTraceId;
  cachedTurns = turns.length === 0 ? emptyTurns : turns;
  return cachedTurns;
}

export function selectNodes(state: TapState): TapNodeView[] {
  const document = state.documentsByTraceId[state.selectedTraceId ?? ""];
  if (document === cachedNodeDocument) return cachedNodes;
  cachedNodeDocument = document;
  cachedNodes = document ? projectSpans(document).steps.flatMap((step) => step.nodes) : emptyNodes;
  return cachedNodes;
}

function mergeDocuments(current: TraceDocument | undefined, incoming: TraceDocument): TraceDocument {
  if (!current) return createTraceDocument(incoming.trace, incoming.spans);
  const spans = new Map(current.spans.map((span) => [span.spanId, span]));
  for (const next of incoming.spans) {
    const previous = spans.get(next.spanId);
    if (!previous || next.revision > previous.revision && sameIdentity(previous, next)) spans.set(next.spanId, next);
  }
  const trace = current.trace.startedAt > incoming.trace.startedAt ? current.trace : incoming.trace;
  return createTraceDocument({ ...trace, spanCount: spans.size }, [...spans.values()]);
}

function sameIdentity(left: AnyTraceSpan, right: AnyTraceSpan): boolean {
  return left.spanId === right.spanId
    && left.traceId === right.traceId
    && left.parentSpanId === right.parentSpanId
    && left.name === right.name
    && left.kind === right.kind
    && left.sequence === right.sequence;
}

function mergeSummaries(current: TraceSummary[], incoming: TraceSummary[]): TraceSummary[] {
  const summaries = new Map(current.map((trace) => [trace.traceId, trace]));
  for (const trace of incoming) summaries.set(trace.traceId, trace);
  return [...summaries.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function summaryAfterChange(current: TraceSummary | undefined, span: AnyTraceSpan, spanCount: number): TraceSummary {
  if (current && span.name !== "agent.turn") return { ...current, spanCount };
  return {
    traceId: span.traceId,
    ...(span.sessionId === undefined ? {} : { sessionId: span.sessionId }),
    status: span.name === "agent.turn" ? span.status : current?.status ?? "running",
    startedAt: span.name === "agent.turn" ? span.startedAt : current?.startedAt ?? span.startedAt,
    ...(span.name === "agent.turn" && span.endedAt !== undefined ? { endedAt: span.endedAt } : {}),
    ...(span.name === "agent.turn" && span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
    spanCount,
    integrity: (current?.integrity ?? true) && span.integrity,
  };
}

function latestNodeId(document: TraceDocument | undefined): string | null {
  return document?.spans.reduce<AnyTraceSpan | undefined>(
    (latest, span) => !latest || span.sequence >= latest.sequence ? span : latest,
    undefined,
  )?.spanId ?? null;
}
