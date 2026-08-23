/**
 * Artifact 模块统一出口。
 *
 * Artifact 是面试流水线各工具之间的数据载体（文件文本、文字稿、结构化面试、问题分析），
 * 通过 id 引用在工具间传递大对象，避免大段内容挤占模型上下文。
 *
 * 对外暴露：
 * - InMemoryArtifactStore：内存版存储实现
 * - ArtifactAccessError：读取失败/种类不匹配时抛出的错误
 * - ArtifactKind / ArtifactMetadata / ArtifactStore：类型定义
 */
export { InMemoryArtifactStore } from "./store.js";
export { ArtifactAccessError } from "./types.js";
export type {
    ArtifactKind,
    ArtifactMetadata,
    ArtifactStore,
} from "./types.js";
