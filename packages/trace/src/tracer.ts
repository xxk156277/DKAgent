import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sanitizeTraceEvent } from "./sanitize.js";
import type {
    TraceEvent,
    TraceEventName,
    TraceEventOptions,
    TraceModule,
    TraceOperation,
    TraceSink,
    TraceSpan,
} from "./types.js";

interface ActiveTraceContext {
    sessionId?: string;
    traceId?: string;
    spanId?: string;
    step?: number;
    module?: TraceModule;
    operation?: string;
}

/** 轻量结构化 Tracer：负责关联关系，业务模块只描述发生了什么。 */
export class Tracer {
    private readonly context = new AsyncLocalStorage<ActiveTraceContext>();
    private sequence = 0;

    public constructor(private readonly sink?: TraceSink) {}

    /** 在日志上下文绑定当前 Session，业务模块无需重复传递关联字段。 */
    public withSession<T>(sessionId: string, operation: () => T | Promise<T>): T | Promise<T> {
        return this.context.run({ ...this.context.getStore(), sessionId }, operation);
    }

    /** 每次用户输入创建新的根 Trace。 */
    public trace<T>(name: TraceEventName, input: unknown, operation: TraceOperation<T>): Promise<T> {
        const active = this.context.getStore();
        return this.runSpan(name, input, operation, {
            traceId: randomUUID(),
            ...(active?.sessionId === undefined ? {} : { sessionId: active.sessionId }),
        });
    }

    /** 在当前 Trace 中创建子操作；没有上层时也可独立工作。 */
    public span<T>(
        name: TraceEventName,
        input: unknown,
        operation: TraceOperation<T>,
        options: TraceEventOptions = {},
    ): Promise<T> {
        const active = this.context.getStore();
        const step = options.step ?? active?.step;
        const module = options.module ?? active?.module;
        const operationName = options.operation ?? active?.operation;
        return this.runSpan(name, input, operation, {
            ...(active?.sessionId === undefined ? {} : { sessionId: active.sessionId }),
            traceId: active?.traceId ?? randomUUID(),
            ...(active?.spanId === undefined ? {} : { parentSpanId: active.spanId }),
            ...(step === undefined ? {} : { step }),
            ...(module === undefined ? {} : { module }),
            ...(operationName === undefined ? {} : { operation: operationName }),
        });
    }

    /** 记录无需独立耗时区间的过程节点。 */
    public event(name: TraceEventName, data: unknown, options: TraceEventOptions = {}): void {
        const active = this.context.getStore();
        const step = options.step ?? active?.step;
        const module = options.module ?? active?.module;
        const operationName = options.operation ?? active?.operation;
        this.publish(name, "event", data, {
            ...(active?.sessionId === undefined ? {} : { sessionId: active.sessionId }),
            traceId: active?.traceId ?? randomUUID(),
            ...(active?.spanId === undefined ? {} : { spanId: active.spanId }),
            ...(step === undefined ? {} : { step }),
            ...(module === undefined ? {} : { module }),
            ...(operationName === undefined ? {} : { operation: operationName }),
        });
    }

    private async runSpan<T>(
        name: TraceEventName,
        input: unknown,
        operation: TraceOperation<T>,
        parent: {
            sessionId?: string;
            traceId: string;
            parentSpanId?: string;
            step?: number;
            module?: TraceModule;
            operation?: string;
        },
    ): Promise<T> {
        const spanId = randomUUID();
        const startedAt = Date.now();
        let output: unknown;
        const span: TraceSpan = {
            event: (eventName, data, options = {}) => {
                const step = options.step ?? parent.step;
                const module = options.module ?? parent.module;
                const operationName = options.operation ?? parent.operation;
                this.publish(eventName, "event", data, {
                    ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
                    traceId: parent.traceId,
                    spanId,
                    ...(parent.parentSpanId === undefined ? {} : { parentSpanId: parent.parentSpanId }),
                    ...(step === undefined ? {} : { step }),
                    ...(module === undefined ? {} : { module }),
                    ...(operationName === undefined ? {} : { operation: operationName }),
                });
            },
            setOutput: (value) => {
                output = value;
            },
        };

        this.publish(name, "start", { input }, { ...parent, spanId });
        try {
            const result = await this.context.run(
                {
                    ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
                    traceId: parent.traceId,
                    spanId,
                    ...(parent.step === undefined ? {} : { step: parent.step }),
                    ...(parent.module === undefined ? {} : { module: parent.module }),
                    ...(parent.operation === undefined ? {} : { operation: parent.operation }),
                },
                () => operation(span),
            );
            this.publish(
                name,
                "end",
                { output: output ?? result },
                {
                    ...parent,
                    spanId,
                    durationMs: Date.now() - startedAt,
                },
            );
            return result;
        } catch (error: unknown) {
            this.publish(
                name,
                "error",
                {
                    error: {
                        name: error instanceof Error ? error.name : "Error",
                        message: error instanceof Error ? error.message : String(error),
                    },
                },
                {
                    ...parent,
                    spanId,
                    durationMs: Date.now() - startedAt,
                },
            );
            throw error;
        }
    }

    private publish(
        name: TraceEventName,
        phase: TraceEvent["phase"],
        data: unknown,
        context: {
            sessionId?: string;
            traceId: string;
            spanId?: string;
            parentSpanId?: string;
            step?: number;
            module?: TraceModule;
            operation?: string;
            durationMs?: number;
        },
    ): void {
        if (!this.sink) return;
        const event: TraceEvent = {
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            id: randomUUID(),
            traceId: context.traceId,
            ...(context.spanId === undefined ? {} : { spanId: context.spanId }),
            ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
            sequence: ++this.sequence,
            timestamp: new Date().toISOString(),
            ...(context.durationMs === undefined ? {} : { durationMs: context.durationMs }),
            name,
            phase,
            ...(context.step === undefined ? {} : { step: context.step }),
            ...(context.module === undefined ? {} : { module: context.module }),
            ...(context.operation === undefined ? {} : { operation: context.operation }),
            data,
        };
        try {
            void Promise.resolve(this.sink.emit(sanitizeTraceEvent(event))).catch(() => {
                // 异步 Sink 拒绝也必须与 Agent 隔离。
            });
        } catch {
            // Trace 是被动能力，失败不能影响 Agent。
        }
    }
}
