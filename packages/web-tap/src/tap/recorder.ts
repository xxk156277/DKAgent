import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RuntimeEvent,
  RuntimeEventSink,
} from "@dkagent/agent/runtime-events";

type Listener = (event: RuntimeEvent) => void | Promise<void>;

const sensitiveFieldPattern = /api[-_]?key|authorization|headers?|env(?:ironment)?/i;

interface SanitizedEvent {
  event: RuntimeEvent;
  serialized: string;
}

/** 一次性生成落盘和实时推送共用的脱敏事件。 */
function sanitizeEvent(event: RuntimeEvent): SanitizedEvent {
  try {
    const serialized = JSON.stringify(event, (key, value) =>
      sensitiveFieldPattern.test(key) ? "[REDACTED]" : value,
    );
    if (serialized === undefined) throw new Error("事件无法序列化");
    return {
      // JSON round-trip 同时完成深拷贝，避免修改 Agent Core 的原始事件。
      event: JSON.parse(serialized) as RuntimeEvent,
      serialized,
    };
  } catch (error: unknown) {
    const sanitized = {
      ...event,
      payload: {
        serializationError: error instanceof Error ? error.message : String(error),
      },
    } satisfies RuntimeEvent;
    return {
      event: sanitized,
      serialized: JSON.stringify(sanitized),
    };
  }
}

/** Agent Core 之外的 Tap 记录器：持久化事件并向 Viewer 实时推送。 */
export class TapRecorder implements RuntimeEventSink {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = console.warn,
  ) {}

  emit(event: RuntimeEvent): void {
    const sanitized = sanitizeEvent(event);
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(sanitized.event)).catch(() => {
          // 隔离异步 Viewer 订阅者拒绝。
        });
      } catch {
        // 隔离 Viewer 订阅者，不能影响写入或 Agent Core。
      }
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${sanitized.serialized}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.warn(`Tap trace 写入失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** 告警回调同属观测端，不能破坏后续队列。 */
  private warn(message: string): void {
    try {
      this.onWarning(message);
    } catch {
      // 隔离告警消费者自身的异常。
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readEvents(): Promise<RuntimeEvent[]> {
    // 补读必须排在已入队写入之后，避免重连窗口丢事件。
    await this.writeQueue;
    try {
      const content = await readFile(this.filePath, "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RuntimeEvent);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
