import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sanitizeError, sanitizeJson } from "./sanitize.js";
import type {
    AnyTraceSpan, JsonObject, JsonValue, SpanEventName, SpanInputMap, SpanKindMap,
    SpanName, SpanOutputMap, SyncTraceOperation, TraceOperation, TraceSink, TraceSpan, TraceSpanHandle,
    TraceSpanOptions, TracerOptions,
} from "./types.js";

interface ActiveContext { traceId?: string; sessionId?: string; spanId?: string; sequence?: { value: number }; safeErrors?: Set<unknown> }
interface State<Name extends SpanName> { span: TraceSpan<Name>; outputSet: boolean; started: number; closed: boolean; safeErrors: Set<unknown> }

const kinds: { [Name in SpanName]: SpanKindMap[Name] } = {
    "agent.turn": "AGENT", "agent.step": "STEP", "context.build": "CONTEXT", "context.compact": "CONTEXT",
    "model.generate": "LLM", "tool.execute": "TOOL", "memory.recall": "MEMORY", "memory.extract": "MEMORY",
    "memory.write": "MEMORY", "artifact.put": "ARTIFACT", "artifact.get": "ARTIFACT",
};

export class Tracer {
    private readonly context = new AsyncLocalStorage<ActiveContext>();
    private writeFailed = false;

    public constructor(private readonly sink?: TraceSink, private readonly options: TracerOptions = {}) {}

    public withSession<T>(sessionId: string, operation: () => T | Promise<T>): T | Promise<T> {
        const active = this.context.getStore();
        if (active?.traceId !== undefined && active.sessionId !== sessionId) {
            return Promise.reject(new Error("withSession session mismatch inside active Trace"));
        }
        return this.context.run({ ...active, sessionId }, operation);
    }

    public trace<T>(name: "agent.turn", input: SpanInputMap["agent.turn"], operation: TraceOperation<"agent.turn", T>): Promise<T> {
        if ((name as string) !== "agent.turn") return Promise.reject(new Error("Tracer.trace 只允许 agent.turn 根 Span"));
        const active = this.context.getStore();
        if (active?.traceId !== undefined) return Promise.reject(new Error("Tracer.trace 不允许嵌套 active Trace"));
        return this.runSpan(name, input, operation, {
            traceId: randomUUID(), sequence: { value: 0 }, safeErrors: new Set<unknown>(),
            ...(active?.sessionId === undefined ? {} : { sessionId: active.sessionId }),
        });
    }

    public span<Name extends Exclude<SpanName, "agent.turn">, T>(
        name: Name, input: SpanInputMap[Name], operation: TraceOperation<Name, T>, options: TraceSpanOptions = {},
    ): Promise<T> {
        const active = this.context.getStore();
        if ((name as SpanName) === "agent.turn") return Promise.reject(new Error("Tracer.span 不允许创建 agent.turn 根 Span"));
        if (!Object.hasOwn(kinds, name)) return Promise.reject(new Error(`未知 Span name: ${String(name)}`));
        if (active?.traceId === undefined || active.sequence === undefined) {
            return Promise.resolve().then(() => operation(this.noopHandle(name)));
        }
        return this.runSpan(name, input, operation, {
            traceId: active.traceId, sequence: active.sequence,
            safeErrors: active.safeErrors ?? new Set<unknown>(),
            ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
            ...(active.spanId === undefined ? {} : { parentSpanId: active.spanId }),
            ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
        });
    }

    public spanSync<Name extends Exclude<SpanName, "agent.turn">, T>(
        name: Name, input: SpanInputMap[Name], operation: SyncTraceOperation<Name, T>, options: TraceSpanOptions = {},
    ): T {
        const active = this.context.getStore();
        if ((name as SpanName) === "agent.turn") throw new Error("Tracer.spanSync 不允许创建 agent.turn 根 Span");
        if (!Object.hasOwn(kinds, name)) throw new Error(`未知 Span name: ${String(name)}`);
        if (active?.traceId === undefined || active.sequence === undefined) {
            const result = operation(this.noopHandle(name));
            if (this.isPromiseLike(result)) {
                void Promise.resolve(result).catch(() => undefined);
                throw new Error("spanSync operation must return synchronously");
            }
            return result as T;
        }
        return this.runSpanSync(name, input, operation, {
            traceId: active.traceId, sequence: active.sequence,
            safeErrors: active.safeErrors ?? new Set<unknown>(),
            ...(active.sessionId === undefined ? {} : { sessionId: active.sessionId }),
            ...(active.spanId === undefined ? {} : { parentSpanId: active.spanId }),
            ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
        });
    }

    private noopHandle<Name extends SpanName>(name: Name): TraceSpanHandle<Name> {
        const handle = name === "model.generate"
            ? { event: () => undefined, setOutput: () => undefined, setTokenUsage: () => undefined }
            : { event: () => undefined, setOutput: () => undefined };
        return handle as unknown as TraceSpanHandle<Name>;
    }

    private async runSpan<Name extends SpanName, T>(
        name: Name, input: SpanInputMap[Name], operation: TraceOperation<Name, T>, parent: Parent,
    ): Promise<T> {
        const state = this.createState(name, input, parent);
        this.publish(state.span);
        try {
            const result = await this.context.run({
                traceId: parent.traceId, sequence: parent.sequence, spanId: state.span.spanId,
                safeErrors: parent.safeErrors,
                ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
            }, () => operation(this.handle(state)));
            this.finish(state);
            return result;
        } catch (error) {
            if (state.span.name === "model.generate") parent.safeErrors.add(error);
            this.finishError(state, error);
            throw error;
        }
    }

    private runSpanSync<Name extends SpanName, T>(
        name: Name, input: SpanInputMap[Name], operation: SyncTraceOperation<Name, T>, parent: Parent,
    ): T {
        const state = this.createState(name, input, parent);
        this.publish(state.span);
        try {
            const result = this.context.run({
                traceId: parent.traceId, sequence: parent.sequence, spanId: state.span.spanId,
                safeErrors: parent.safeErrors,
                ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
            }, () => operation(this.handle(state))) as T;
            if (this.isPromiseLike(result)) {
                void Promise.resolve(result).catch(() => undefined);
                throw new Error("spanSync operation must return synchronously");
            }
            this.finish(state);
            return result;
        } catch (error) {
            if (state.span.name === "model.generate") parent.safeErrors.add(error);
            this.finishError(state, error);
            throw error;
        }
    }

    private createState<Name extends SpanName>(name: Name, input: SpanInputMap[Name], parent: Parent): State<Name> {
        const inputClone = this.clone(input, name !== "model.generate");
        const attributesClone = this.clone(parent.attributes ?? {});
        const state: State<Name> = {
            span: {
                schemaVersion: 2, traceId: parent.traceId, spanId: randomUUID(),
                ...(parent.parentSpanId === undefined ? {} : { parentSpanId: parent.parentSpanId }),
                ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
                name, kind: kinds[name], status: "running", sequence: ++parent.sequence.value, revision: 1,
                startedAt: new Date().toISOString(), input: inputClone.value as SpanInputMap[Name], output: null,
                tokenUsage: null, attributes: attributesClone.value as JsonObject ?? {}, events: [], integrity: true,
            },
            outputSet: false, started: performance.now(), closed: false, safeErrors: parent.safeErrors,
        };
        if (inputClone.error) {
            state.span.input = { serializationError: "input" } as unknown as SpanInputMap[Name];
            this.serializationError(state, "input", false);
        }
        if (attributesClone.error) {
            state.span.attributes = {};
            this.serializationError(state, "attributes", false);
        }
        return state;
    }

    private handle<Name extends SpanName>(state: State<Name>): TraceSpanHandle<Name> {
        const base = {
            event: (name: SpanEventName, data: JsonValue) => { if (!state.closed) this.addEvent(state, name, data); },
            setOutput: (output: SpanOutputMap[Name]) => {
                if (state.closed) return;
                const clone = this.clone(output, state.span.name !== "model.generate");
                if (clone.error) {
                    state.span.output = null; state.outputSet = true; this.serializationError(state, "output"); return;
                }
                state.span.output = clone.value as SpanOutputMap[Name]; state.outputSet = true;
            },
        };
        const model = state.span.name === "model.generate"
            ? { ...base, setTokenUsage: (usage: import("./types.js").TraceTokenUsage) => {
                if (state.closed) return;
                const clone = this.clone(usage);
                if (clone.error) { state.span.tokenUsage = null; this.serializationError(state, "tokenUsage"); return; }
                state.span.tokenUsage = clone.value ?? null;
            } }
            : base;
        return model as TraceSpanHandle<Name>;
    }

    private addEvent<Name extends SpanName>(state: State<Name>, name: SpanEventName, data: JsonValue): void {
        const clone = this.clone(data);
        if (clone.error) { this.serializationError(state, "event"); return; }
        state.span.events.push({ name, timestamp: new Date().toISOString(), sequence: state.span.events.length + 1, data: clone.value! });
        state.span.revision += 1;
        this.publish(state.span);
    }

    private finish<Name extends SpanName>(state: State<Name>): void {
        if (state.closed) return;
        if (!state.outputSet) { state.span.integrity = false; this.missingOutput(state); }
        state.span.status = "ok"; state.span.endedAt = new Date().toISOString(); state.span.durationMs = performance.now() - state.started; state.closed = true;
        state.span.revision += 1; this.publish(state.span);
    }

    private finishError<Name extends SpanName>(state: State<Name>, error: unknown): void {
        if (state.closed) return;
        const safe = state.span.name === "model.generate" || state.safeErrors.has(error);
        state.span.status = "error"; state.span.error = sanitizeError(error, safe); state.span.endedAt = new Date().toISOString(); state.closed = true;
        state.span.durationMs = performance.now() - state.started;
        state.span.revision += 1; this.publish(state.span);
    }

    private missingOutput<Name extends SpanName>(state: State<Name>): void {
        state.span.events.push({ name: "trace.output_missing", timestamp: new Date().toISOString(), sequence: state.span.events.length + 1, data: { code: "TRACE_OUTPUT_MISSING" } });
    }

    private serializationError<Name extends SpanName>(state: State<Name>, field: string, publish = true): void {
        state.span.integrity = false;
        state.span.events.push({ name: "trace.serialization_error", timestamp: new Date().toISOString(), sequence: state.span.events.length + 1, data: { field } });
        if (publish) { state.span.revision += 1; this.publish(state.span); }
    }

    private clone<T>(value: T, sanitize = true): { value?: T; error?: Error } {
        try {
            const result = toJsonValue(value);
            return result.error
                ? { error: result.error }
                : { value: (sanitize ? sanitizeJson(result.value!) : result.value) as T };
        } catch (error) {
            return { error: error instanceof Error ? error : new Error(String(error)) };
        }
    }

    private isPromiseLike(value: unknown): value is PromiseLike<unknown> {
        return value !== null && (typeof value === "object" || typeof value === "function")
            && typeof (value as { then?: unknown }).then === "function";
    }

    private publish<Name extends SpanName>(span: TraceSpan<Name>): void {
        if (!this.sink) return;
        try { this.sink.upsert(structuredClone(span) as AnyTraceSpan); this.writeFailed = false; }
        catch (error) {
            if (!this.writeFailed) { this.writeFailed = true; try { this.options.onWriteError?.(error); } catch { /* isolated */ } }
        }
    }
}

interface Parent {
    traceId: string; sequence: { value: number }; sessionId?: string; parentSpanId?: string;
    attributes?: JsonObject; safeErrors: Set<unknown>;
}

function toJsonValue(value: unknown, seen = new Set<object>()): { value?: JsonValue; error?: Error } {
    if (value === null || typeof value === "string" || typeof value === "boolean") return { value };
    if (typeof value === "number") return Number.isFinite(value) ? { value } : { error: new Error("non-finite number") };
    if (typeof value !== "object") return { error: new Error("value is not JSON-safe") };
    if (seen.has(value)) return { error: new Error("circular value") };
    seen.add(value);
    if (Array.isArray(value)) {
        const items: JsonValue[] = [];
        for (const item of value) {
            const result = toJsonValue(item, seen);
            if (result.error) return result;
            items.push(result.value!);
        }
        seen.delete(value);
        return { value: items };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { error: new Error("value is not a plain object") };
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
        const childResult = toJsonValue(child, seen);
        if (childResult.error) return childResult;
        result[key] = childResult.value!;
    }
    seen.delete(value);
    return { value: result };
}
