import { randomUUID } from "node:crypto";
import type { Tracer } from "@dkagent/trace";
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

    public constructor(private readonly tracer?: Tracer) {}

    public put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string {
        const id = randomUUID();
        this.artifacts.set(id, { kind, value, metadata });
        this.tracer?.event(
            "artifact.created",
            {
                artifactId: id,
                artifactType: kind,
                producer: metadata.producer,
                characterCount: metadata.characterCount,
                itemCount: metadata.itemCount,
                exposedCharacterCount: metadata.exposedCharacterCount,
                omittedCharacterCount: Math.max(
                    0,
                    (metadata.characterCount ?? 0) - (metadata.exposedCharacterCount ?? 0),
                ),
            },
            { module: "artifact", operation: metadata.producer },
        );
        return id;
    }

    public get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T {
        const artifact = this.artifacts.get(id);
        const hit = artifact !== undefined && artifact.kind === expectedKind;
        this.tracer?.event(
            "artifact.resolved",
            {
                artifactId: id,
                artifactType: expectedKind,
                consumer,
                hit,
            },
            { module: "artifact", operation: consumer },
        );

        if (!artifact) {
            throw new ArtifactAccessError("Artifact 不存在或已过期");
        }
        if (artifact.kind !== expectedKind) {
            throw new ArtifactAccessError("Artifact 类型不匹配");
        }
        return artifact.value as T;
    }
}
