import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeEvent, RuntimeEventSink } from "../runtime/events.js";

type Listener = (event: RuntimeEvent) => void;

/** 将不可序列化的事件降级为可诊断的 JSONL 记录。 */
function serializeEvent(event: RuntimeEvent): string {
  try {
    return JSON.stringify(event);
  } catch (error: unknown) {
    return JSON.stringify({
      ...event,
      payload: {
        serializationError: error instanceof Error ? error.message : String(error),
      },
    });
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 隔离 Viewer 订阅者，不能影响写入或 Agent Core。
      }
    }

    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${serializeEvent(event)}\n`, "utf8");
      })
      .catch((error: unknown) => {
        this.onWarning(
          `Tap trace 写入失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async readEvents(): Promise<RuntimeEvent[]> {
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
