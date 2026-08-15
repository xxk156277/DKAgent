import { Tracer } from "@dkagent/trace";
import type {
    MemoryCaptureInput,
    MemoryExtractorPort,
    MemoryStore,
    MemoryWriter,
} from "./types.js";

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
        let rejectedCount = 0;

        for (const candidate of candidates) {
            try {
                this.store.upsert({
                    ...candidate,
                    source: "automatic",
                    sourceSessionId: input.sessionId,
                });
                savedCount += 1;
            } catch {
                rejectedCount += 1;
            }
        }

        this.tracer.event("memory.write", {
            candidateCount: candidates.length,
            savedCount,
            rejectedCount,
            memories: candidates.map(({ type, key }) => ({ type, key })),
        });
    }
}
