import type { AnyTraceSpan } from "./types.js";

const kinds = {
    "agent.turn": "AGENT", "agent.step": "STEP", "context.build": "CONTEXT", "context.compact": "CONTEXT",
    "model.generate": "LLM", "tool.execute": "TOOL", "memory.recall": "MEMORY", "memory.extract": "MEMORY",
    "memory.write": "MEMORY", "artifact.put": "ARTIFACT", "artifact.get": "ARTIFACT",
} as const;

export function copySpan(span: AnyTraceSpan): AnyTraceSpan {
    return structuredClone(span);
}

export function sameSpanIdentity(a: AnyTraceSpan, b: AnyTraceSpan): boolean {
    return a.traceId === b.traceId && a.spanId === b.spanId && a.parentSpanId === b.parentSpanId
        && a.sessionId === b.sessionId && a.name === b.name && a.kind === b.kind && a.sequence === b.sequence;
}

export function isValidSpan(value: AnyTraceSpan): boolean {
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
