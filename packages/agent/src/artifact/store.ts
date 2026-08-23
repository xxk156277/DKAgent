import { randomUUID } from "node:crypto";
import type { Tracer } from "@dkagent/trace";
import {
    ArtifactAccessError,
    type ArtifactKind,
    type ArtifactMetadata,
    type ArtifactStore,
} from "./types.js";

/**
 * 内存中实际保存的一条 Artifact。
 */
interface StoredArtifact {
    /** 种类，见 ArtifactKind。 */
    kind: ArtifactKind;
    /** 实际数据，读取时按声明类型返回。 */
    value: unknown;
    /** 观测用元数据。 */
    metadata: ArtifactMetadata;
}

/**
 * 内存版 Artifact 存储：基于 Map 保存，进程结束即清空。
 *
 * 用途：在单次 Agent 运行期间，让工具之间通过 id 传递大对象
 * （例如完整文件文本、文字稿），避免把大段内容直接塞进模型上下文。
 */
export class InMemoryArtifactStore implements ArtifactStore {
    /** id -> Artifact 的映射。 */
    private readonly artifacts = new Map<string, StoredArtifact>();

    /** @param tracer 可选的追踪器，用于记录 artifact.created / artifact.resolved 事件。 */
    public constructor(private readonly tracer?: Tracer) {}

    /**
     * 保存一条 Artifact 并生成唯一 id。
     *
     * 输入：kind（种类）、value（任意值）、metadata（元数据）。
     * 输出：新生成的 UUID 字符串，作为后续读取的句柄。
     */
    public put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string {
        const id = randomUUID();
        this.artifacts.set(id, { kind, value, metadata });
        // 记录创建事件；omittedCharacterCount 用于观测「有多少字符未暴露给模型」。
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

    /**
     * 按 id 读取一条 Artifact，并校验种类一致。
     *
     * 输入：id（put 返回的句柄）、expectedKind（期望种类）、consumer（消费者名，用于观测）。
     * 输出：存储时的原始值。
     * 失败：id 不存在或种类不匹配时抛出 ArtifactAccessError。
     */
    public get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T {
        const artifact = this.artifacts.get(id);
        // 命中条件：条目存在且种类与期望一致；无论命中与否都会记录解析事件。
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
