import type { AnyTraceSpan, TraceDocument, TraceSummary } from "./types.js";

export function createTraceDocument(
    trace: TraceSummary,
    spans: AnyTraceSpan[],
    expectedRootSpanId?: string,
): TraceDocument {
    if (spans.length > 1000) throw new Error(`Trace ${trace.traceId} 超过 1000 个 Span，不支持无界读取`);
    const ordered = [...spans].sort((left, right) => left.sequence - right.sequence);
    const ids = new Set(ordered.map((span) => span.spanId));
    const roots = ordered.filter((span) => span.name === "agent.turn" && span.parentSpanId === undefined);
    const diagnostics = {
        missingRoot: roots.length !== 1 || (expectedRootSpanId !== undefined && roots[0]?.spanId !== expectedRootSpanId),
        missingParent: ordered.filter((span) => span.parentSpanId !== undefined && !ids.has(span.parentSpanId)).map((span) => span.spanId),
        running: ordered.filter((span) => span.status === "running").map((span) => span.spanId),
        outputMissing: ordered.filter((span) => span.events.some((event) => event.name === "trace.output_missing")).map((span) => span.spanId),
        serializationError: ordered.filter((span) => span.events.some((event) => event.name === "trace.serialization_error")).map((span) => span.spanId),
    };
    const complete = !diagnostics.missingRoot
        && diagnostics.missingParent.length === 0
        && diagnostics.running.length === 0
        && diagnostics.outputMissing.length === 0
        && diagnostics.serializationError.length === 0
        && trace.status !== "running"
        && trace.integrity
        && ordered.every((span) => span.integrity);
    return { schemaVersion: 2, trace, spans: ordered, complete, diagnostics };
}
