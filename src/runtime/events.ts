import { randomUUID } from "node:crypto";

export type RuntimeEventType =
  | "turn.start"
  | "context.before"
  | "context.after"
  | "model.response"
  | "tool.call"
  | "tool.result"
  | "turn.end"
  | "turn.error";

export interface RuntimeEvent<TPayload = unknown> {
  id: string;
  sessionId: string;
  turnId: string;
  step?: number;
  sequence: number;
  timestamp: string;
  type: RuntimeEventType;
  payload: TPayload;
}

/** 可选观测端口；其失败不会影响 Agent 核心执行。 */
export interface RuntimeEventSink {
  emit(event: RuntimeEvent): void | Promise<void>;
}

export class RuntimeEventPublisher {
  private readonly sessionId = randomUUID();
  private sequence = 0;

  constructor(private readonly sink?: RuntimeEventSink) {}

  createTurnId(): string {
    return randomUUID();
  }

  emit(
    type: RuntimeEventType,
    turnId: string,
    payload: unknown,
    step?: number,
  ): void {
    if (!this.sink) return;

    const event: RuntimeEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      turnId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      type,
      payload,
      ...(step === undefined ? {} : { step }),
    };

    try {
      void Promise.resolve(this.sink.emit(event)).catch(() => {
        // 异步观测器失败同样不能影响 Agent。
      });
    } catch {
      // 观测器失败不能影响 Agent。
    }
  }
}
