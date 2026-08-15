import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sanitizeTraceEvent } from "./sanitize.js";
import type {
  TraceEvent,
  TraceEventName,
  TraceEventOptions,
  TraceOperation,
  TraceSink,
  TraceSpan,
} from "./types.js";

interface ActiveTraceContext {
  traceId: string;
  spanId?: string;
  step?: number;
}

/** 轻量结构化 Tracer：负责关联关系，业务模块只描述发生了什么。 */
export class Tracer {
  private readonly context = new AsyncLocalStorage<ActiveTraceContext>();
  private sequence = 0;

  public constructor(private readonly sink?: TraceSink) {}

  /** 每次用户输入创建新的根 Trace。 */
  public trace<T>(
    name: TraceEventName,
    input: unknown,
    operation: TraceOperation<T>,
  ): Promise<T> {
    return this.runSpan(name, input, operation, { traceId: randomUUID() });
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
    return this.runSpan(name, input, operation, {
      traceId: active?.traceId ?? randomUUID(),
      ...(active?.spanId === undefined ? {} : { parentSpanId: active.spanId }),
      ...(step === undefined ? {} : { step }),
    });
  }

  /** 记录无需独立耗时区间的过程节点。 */
  public event(name: TraceEventName, data: unknown, options: TraceEventOptions = {}): void {
    const active = this.context.getStore();
    const step = options.step ?? active?.step;
    this.publish(name, "event", data, {
      traceId: active?.traceId ?? randomUUID(),
      ...(active?.spanId === undefined ? {} : { spanId: active.spanId }),
      ...(step === undefined ? {} : { step }),
    });
  }

  private async runSpan<T>(
    name: TraceEventName,
    input: unknown,
    operation: TraceOperation<T>,
    parent: { traceId: string; parentSpanId?: string; step?: number },
  ): Promise<T> {
    const spanId = randomUUID();
    const startedAt = Date.now();
    let output: unknown;
    const span: TraceSpan = {
      event: (eventName, data, options = {}) => {
        const step = options.step ?? parent.step;
        this.publish(eventName, "event", data, {
          traceId: parent.traceId,
          spanId,
          ...(parent.parentSpanId === undefined ? {} : { parentSpanId: parent.parentSpanId }),
          ...(step === undefined ? {} : { step }),
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
          traceId: parent.traceId,
          spanId,
          ...(parent.step === undefined ? {} : { step: parent.step }),
        },
        () => operation(span),
      );
      this.publish(name, "end", { output: output ?? result }, {
        ...parent,
        spanId,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error: unknown) {
      this.publish(name, "error", {
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, {
        ...parent,
        spanId,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private publish(
    name: TraceEventName,
    phase: TraceEvent["phase"],
    data: unknown,
    context: {
      traceId: string;
      spanId?: string;
      parentSpanId?: string;
      step?: number;
      durationMs?: number;
    },
  ): void {
    if (!this.sink) return;
    const event: TraceEvent = {
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
