import type { AnyTraceSpan, SpanChange, TraceListener, TraceStore } from "./types.js";

function copy<T>(value: T): T {
    return structuredClone(value);
}

function validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Trace Store limit 必须是 1～1000 的整数");
    }
}

export class MemoryTraceStore implements TraceStore {
    private readonly spans = new Map<string, AnyTraceSpan>();
    private readonly listeners = new Set<TraceListener>();

    public constructor(private readonly capacity = 2_000) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Trace Store capacity 必须是正整数");
    }

    public upsert(span: AnyTraceSpan): void {
        try {
            if (!isValidSpan(span)) return;
            const current = this.spans.get(span.spanId);
            if (current && (current.revision >= span.revision
                || (current.status !== "running" && span.status === "running"))) return;
            if (current && !sameIdentity(current, span)) return;
            const next = copy(span);
            this.spans.set(next.spanId, next);
            while (this.spans.size > this.capacity) {
                const oldest = this.spans.keys().next().value as string | undefined;
                if (oldest === undefined) break;
                this.spans.delete(oldest);
            }
            const type: SpanChange["type"] = current === undefined
                ? next.status === "running" ? "span_started" : "span_ended"
                : next.status === "running" ? "span_updated" : "span_ended";
            const change = { type, traceId: next.traceId, span: copy(next) } as SpanChange;
            for (const listener of this.listeners) {
                try { listener({ ...change, span: copy(next) }); } catch { /* passive listener */ }
            }
        } catch {
            // Sink is passive: malformed or hostile runtime snapshots are ignored.
        }
    }

    public list(limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        return [...this.spans.values()].slice(-limit).map(copy);
    }

    public listByTrace(traceId: string, limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        return [...this.spans.values()].filter((span) => span.traceId === traceId).slice(-limit).map(copy);
    }

    public listBySession(sessionId?: string, limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        return [...this.spans.values()].filter((span) => span.sessionId === sessionId).slice(-limit).map(copy);
    }

    public subscribe(listener: TraceListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

function sameIdentity(a: AnyTraceSpan, b: AnyTraceSpan): boolean {
    return a.traceId === b.traceId && a.spanId === b.spanId && a.parentSpanId === b.parentSpanId
        && a.sessionId === b.sessionId && a.name === b.name && a.kind === b.kind && a.sequence === b.sequence;
}

const kinds = {
    "agent.turn": "AGENT", "agent.step": "STEP", "context.build": "CONTEXT", "context.compact": "CONTEXT",
    "model.generate": "LLM", "tool.execute": "TOOL", "memory.recall": "MEMORY", "memory.extract": "MEMORY",
    "memory.write": "MEMORY", "artifact.put": "ARTIFACT", "artifact.get": "ARTIFACT",
} as const;

function isValidSpan(value: AnyTraceSpan): boolean {
    const span = value as unknown as Record<string, unknown>;
    if (span.schemaVersion !== 2 || typeof span.spanId !== "string" || typeof span.traceId !== "string") return false;
    if (typeof span.name !== "string" || !Object.hasOwn(kinds, span.name) || span.kind !== kinds[span.name as keyof typeof kinds]) return false;
    if (span.status !== "running" && span.status !== "ok" && span.status !== "error") return false;
    if (!positiveInteger(span.revision) || !positiveInteger(span.sequence)) return false;
    if (typeof span.startedAt !== "string" || !isJsonSafe(value)) return false;
    return span.durationMs === undefined || typeof span.durationMs === "number" && Number.isFinite(span.durationMs);
}

function positiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isFinite(value);
}

function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every((item) => isJsonSafe(item, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.values(value).every((child) => isJsonSafe(child, seen));
}
