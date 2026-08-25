import type { AnyTraceSpan, SpanChange, TraceListener, TraceStore } from "./types.js";
import { isValidSpan, sameSpanIdentity } from "./span-codec.js";

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
            if (current && !sameSpanIdentity(current, span)) return;
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
