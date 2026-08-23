import { Tracer } from "@dkagent/trace";
import type { JsonValue } from "@dkagent/trace";
import type {
    MemoryCaptureInput,
    MemoryExtractorPort,
    MemoryStore,
    MemoryWriter,
} from "./types.js";

/** 将自动提取到的候选逐条保存；单条失败不影响后续保存。 */
export class AutomaticMemoryWriter implements MemoryWriter {
    private readonly tracer: Tracer;

    public constructor(
        private readonly extractor: MemoryExtractorPort,
        private readonly store: MemoryStore,
        tracer?: Tracer,
    ) {
        const inherited = extractor.getTracer?.();
        if (tracer !== undefined && inherited !== undefined && tracer !== inherited) {
            throw new Error("AutomaticMemoryWriter tracer must match MemoryExtractor tracer");
        }
        this.tracer = tracer ?? inherited ?? new Tracer();
    }

    public async capture(input: MemoryCaptureInput): Promise<void> {
        const candidates = await this.extractor.extract(input);
        return this.tracer.span("memory.write", {
            candidates: candidates as unknown as JsonValue[],
        }, async (span) => {
            let savedCount = 0;
            let ignoredCount = 0;
            const failures: unknown[] = [];

            for (const candidate of candidates) {
                try {
                    const saved = this.store.upsert({
                        ...candidate,
                        source: "automatic",
                        sourceSessionId: input.sessionId,
                    });
                    if (saved.source === "explicit") {
                        ignoredCount += 1;
                    } else {
                        savedCount += 1;
                    }
                } catch (error: unknown) {
                    failures.push(error);
                }
            }

            span.setOutput({ savedCount, ignoredCount, failedCount: failures.length });
            if (failures.length > 0) {
                throw new AggregateError(
                    failures,
                    `Memory 自动写入失败：${failures.length} 条`,
                );
            }
        });
    }
}
