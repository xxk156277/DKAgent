export type JsonValue =
    | null
    | boolean
    | number
    | string
    | JsonValue[]
    | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SpanName =
    | "agent.turn" | "agent.step" | "context.build" | "context.compact"
    | "model.generate" | "tool.execute" | "memory.recall" | "memory.extract"
    | "memory.write" | "artifact.put" | "artifact.get";

export type SpanKindMap = {
    "agent.turn": "AGENT"; "agent.step": "STEP";
    "context.build": "CONTEXT"; "context.compact": "CONTEXT";
    "model.generate": "LLM"; "tool.execute": "TOOL";
    "memory.recall": "MEMORY"; "memory.extract": "MEMORY";
    "memory.write": "MEMORY"; "artifact.put": "ARTIFACT"; "artifact.get": "ARTIFACT";
};
export type SpanKind = SpanKindMap[SpanName];
export type SpanStatus = "running" | "ok" | "error";
export type SpanEventName =
    | "context.tokens.counted" | "context.threshold.checked"
    | "context.compaction.planned" | "trace.output_missing" | "trace.serialization_error";

export interface TraceTokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
export interface TraceError { name: string; code?: string; message?: string }
export interface SpanEvent { name: SpanEventName; timestamp: string; sequence: number; data: JsonValue }

export interface TraceModelInput {
    provider: string; model: string; messages: JsonValue[]; systemPrompt?: string;
    tools?: JsonValue[]; maxTokens?: number; temperature?: number;
    responseFormat?: "json_object"; thinking?: "disabled";
}
export interface ContextCompactionTraceInput {
    enabled: boolean;
    triggerRatio: number;
    targetRatio: number;
    maxSummaryTokens: number;
    maxToolResultChars: number;
}
export type TraceModelOutput =
    | { type: "text"; content: string; stopReason: string }
    | { type: "tool_use"; content?: string; toolCalls: JsonValue[]; stopReason: string };

export interface SpanInputMap {
    "agent.turn": { userInput: string };
    "agent.step": { step: number };
    "context.build": { messageCount: number; toolCount: number; maxContextTokens: number; reservedOutputTokens: number; compaction?: ContextCompactionTraceInput };
    "context.compact": { messageCountBefore: number; tokensBefore: number; decision: "summary" | "deletion_fallback" | "none" };
    "model.generate": TraceModelInput;
    "tool.execute": { toolCallId: string; name: string; input: JsonObject };
    "memory.recall": { query: string };
    "memory.extract": { userInput: string; assistantAnswer: string };
    "memory.write": { candidates: JsonValue[] };
    "artifact.put": { kind: string; metadata: JsonObject };
    "artifact.get": { artifactId: string; expectedKind: string; consumer: string };
}
export interface SpanOutputMap {
    "agent.turn": { answer: string };
    "agent.step": { outcome: "answer" | "tool_calls"; stopReason: string; toolCallCount: number };
    "context.build": { messageCount: number; toolCount: number; estimatedInputTokens: number; availableInputTokens: number; compacted: boolean };
    "context.compact": { messageCountBefore: number; messageCountAfter: number; summarizedMessageCount: number; retainedMessageCount: number; tokensBefore: number; tokensAfter: number; fallbackUsed: boolean };
    "model.generate": TraceModelOutput;
    "tool.execute": { success: boolean; data?: JsonValue; error?: { code: string; message: string } };
    "memory.recall": { content: string; characterCount: number };
    "memory.extract": { candidates: JsonValue[] };
    "memory.write": { savedCount: number; ignoredCount: number; failedCount: number };
    "artifact.put": { artifactId: string };
    "artifact.get": { hit: boolean };
}

export interface TraceSpan<Name extends SpanName> {
    schemaVersion: 2; traceId: string; spanId: string; parentSpanId?: string; sessionId?: string;
    name: Name; kind: SpanKindMap[Name]; status: SpanStatus; sequence: number; revision: number;
    startedAt: string; endedAt?: string; durationMs?: number;
    input: SpanInputMap[Name]; output: SpanOutputMap[Name] | null; error?: TraceError;
    tokenUsage: TraceTokenUsage | null; attributes: JsonObject; events: SpanEvent[]; integrity: boolean;
}
export type AnyTraceSpan = { [Name in SpanName]: TraceSpan<Name> }[SpanName];
export type SpanChange =
    | { type: "span_started"; traceId: string; span: AnyTraceSpan }
    | { type: "span_updated"; traceId: string; span: AnyTraceSpan }
    | { type: "span_ended"; traceId: string; span: AnyTraceSpan };

export interface TraceSummary {
    traceId: string;
    sessionId?: string;
    status: SpanStatus;
    startedAt: string;
    endedAt?: string;
    durationMs?: number;
    spanCount: number;
    integrity: boolean;
}

export interface TraceDiagnostics {
    missingRoot: boolean;
    missingParent: string[];
    running: string[];
    outputMissing: string[];
    serializationError: string[];
}

export interface TraceDocument {
    schemaVersion: 2;
    trace: TraceSummary;
    spans: AnyTraceSpan[];
    complete: boolean;
    diagnostics: TraceDiagnostics;
}
export interface TraceReader {
    listTraceSummariesBySession(sessionId: string, limit?: number): TraceSummary[];
    getTraceDocument(traceId: string): TraceDocument | null;
    hasTraceForSession(sessionId: string): boolean;
}
export interface TraceSink { upsert(span: AnyTraceSpan): void }
export type TraceListener = (change: SpanChange) => void;
export interface TraceStore extends TraceSink {
    list(limit?: number): AnyTraceSpan[];
    listByTrace(traceId: string, limit?: number): AnyTraceSpan[];
    listBySession(sessionId?: string, limit?: number): AnyTraceSpan[];
    subscribe(listener: TraceListener): () => void;
}
export interface TracerOptions { onWriteError?: (error: unknown) => void }
export interface TraceSpanOptions { attributes?: JsonObject }
export type TraceSpanHandle<Name extends SpanName = SpanName> = {
    event(name: SpanEventName, data: JsonValue): void;
    setOutput(output: SpanOutputMap[Name]): void;
} & (Name extends "model.generate" ? { setTokenUsage(usage: TraceTokenUsage): void } : Record<never, never>);
export type TraceOperation<Name extends SpanName, T> = (span: TraceSpanHandle<Name>) => T | Promise<T>;
export type SyncTraceOperation<Name extends SpanName, T> =
    (span: TraceSpanHandle<Name>) => T extends PromiseLike<unknown> ? never : T;
