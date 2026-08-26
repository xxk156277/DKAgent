import { Tracer } from "@dkagent/trace";
import type { MemoryCaptureInput, MemoryExtractorPort, MemoryStore, MemoryWriter } from "./types.js";

/** 将自动提取到的候选逐条保存；单条失败不影响后续保存。 */
export class AutomaticMemoryWriter implements MemoryWriter {
    public constructor(
        private readonly extractor: MemoryExtractorPort,
        private readonly store: MemoryStore,
        private readonly tracer: Tracer = new Tracer(),
    ) {}

    public async capture(input: MemoryCaptureInput): Promise<void> {
        const candidates = await this.extractor.extract(input);
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

        this.tracer.event(
            "memory.write",
            {
                candidateCount: candidates.length,
                savedCount,
                ignoredCount,
                failedCount: failures.length,
                memories: candidates.map(({ type, key }) => ({ type, key })),
            },
            { module: "memory", operation: "persist" },
        );

        if (failures.length > 0) {
            throw new AggregateError(failures, `Memory 自动写入失败：${failures.length} 条`);
        }
    }
}
