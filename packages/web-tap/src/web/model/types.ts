import type { AnyTraceSpan, SpanName, TraceDiagnostics, TraceSummary, TraceTokenUsage } from "@dkagent/trace";

export type TapNodeKind = SpanName;
export type TapModuleKind = "context" | "memory" | "artifact" | "tool" | "model" | "agent";

export interface TapNodeView {
  id: string;
  kind: TapNodeKind;
  module: TapModuleKind;
  title: string;
  eventType: SpanName;
  status: "running" | "completed" | "error";
  parentSpanId?: string;
  sequence: number;
  revision: number;
  directTokenUsage: TraceTokenUsage | null;
  subtreeTokenUsage: TraceTokenUsage | null;
  durationMs?: number;
  selfDurationMs?: number;
  integrityWarnings: string[];
  detail: unknown;
  rawSpans: AnyTraceSpan[];
}

export interface TapStepView {
  step: number | "turn";
  nodes: TapNodeView[];
}

export interface TapTurnView {
  id: string;
  trace: TraceSummary;
  complete: boolean;
  diagnostics: TraceDiagnostics;
  steps: TapStepView[];
  rawSpans: AnyTraceSpan[];
}

export type AgentTurnStatus = "running" | "completed" | "error";
export type AgentEvaluationStatus = "passed" | "warning" | "failed" | "unknown";

export interface AgentTurnMetrics {
  status: AgentTurnStatus;
  durationMs?: number;
  stepCount: number;
  modelCallCount: number;
  toolCallCount: number;
  successfulToolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  compactionCount: number;
  integrityIssueCount: number;
  latestCompaction?: {
    tokensBefore: number;
    tokensAfter: number;
    savedRatio: number;
  };
}

export interface AgentEvaluationItem {
  id: string;
  label: string;
  status: AgentEvaluationStatus;
  summary: string;
  evidenceSpanIds: string[];
}

export interface AgentTurnAnalysis {
  metrics: AgentTurnMetrics;
  evaluations: AgentEvaluationItem[];
}
