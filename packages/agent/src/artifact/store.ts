import { randomUUID } from "node:crypto";
import { Tracer } from "@dkagent/trace";
import type { JsonObject, SpanInputMap, TraceSpanHandle } from "@dkagent/trace";
import {
    ArtifactAccessError,
    type ArtifactKind,
    type ArtifactMetadata,
    type ArtifactStore,
} from "./types.js";

interface StoredArtifact {
    kind: ArtifactKind;
    value: unknown;
    metadata: ArtifactMetadata;
}

export class InMemoryArtifactStore implements ArtifactStore {
    private readonly artifacts = new Map<string, StoredArtifact>();
    private readonly tracer: Tracer;

    public constructor(tracer?: Tracer) {
        this.tracer = tracer ?? new Tracer();
    }

    public put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string {
        let input: SpanInputMap["artifact.put"];
        try {
            const producer = metadata.producer;
            const characterCount = metadata.characterCount;
            const itemCount = metadata.itemCount;
            const exposedCharacterCount = metadata.exposedCharacterCount;
            input = {
                kind,
                metadata: {
                    producer,
                    ...(characterCount === undefined ? {} : { characterCount }),
                    ...(itemCount === undefined ? {} : { itemCount }),
                    ...(exposedCharacterCount === undefined ? {} : { exposedCharacterCount }),
                },
            };
        } catch {
            input = { kind, metadata: Symbol("artifact.metadata.serialization") as unknown as JsonObject };
        }
        const operation = (span: TraceSpanHandle<"artifact.put">): string => {
            const id = randomUUID();
            this.artifacts.set(id, { kind, value, metadata });
            span.setOutput({ artifactId: id });
            return id;
        };
        return this.tracer.spanSync("artifact.put", input, operation);
    }

    public get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T {
        const input = { artifactId: id, expectedKind, consumer };
        const operation = (span: TraceSpanHandle<"artifact.get">): T => {
            const artifact = this.artifacts.get(id);
            if (!artifact || artifact.kind !== expectedKind) {
                span.setOutput({ hit: false });
                throw new ArtifactAccessError(!artifact ? "Artifact 不存在或已过期" : "Artifact 类型不匹配");
            }
            span.setOutput({ hit: true });
            return artifact.value as T;
        };
        const result = this.tracer.spanSync("artifact.get", input, (span) => ({
            value: operation(span),
        }));
        return result.value;
    }
}
