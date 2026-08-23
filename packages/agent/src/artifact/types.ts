/**
 * Artifact 的种类。
 *
 * 一条 Artifact 是面试流水线上某个工具产出的数据对象，通过 kind 区分
 * 数据类型与格式。消费者读取时必须声明期望的 kind，类型不匹配会抛出
 * {@link ArtifactAccessError}，避免把错误类型的数据传给下游工具。
 */
export type ArtifactKind =
    /** 完整文件文本：read_file 工具读取的原始文件内容（string）。 */
    | "file_text"
    /** 解析后的面试文字稿：parse_transcript 工具按说话人标题解析出的轮次列表。 */
    | "parsed_transcript"
    /** 结构化面试：structure_interview 工具把轮次组织成问题簇/问题/非问题轮次后的结构。 */
    | "structured_interview"
    /** 问题分析：analyze_answer 工具对单个面试问题产生的评分与改进建议。 */
    | "question_analysis";

/**
 * Artifact 的元数据，仅用于观测（tracing）与日志统计，不参与业务判断。
 */
export interface ArtifactMetadata {
    /** 生产者：创建该 Artifact 的工具名。取值如 "read_file" | "parse_transcript" | "structure_interview" | "analyze_answer"。 */
    producer: string;
    /** 总字符数：内容序列化后的字符长度，例如 JSON.stringify(value).length。 */
    characterCount?: number;
    /** 条目数：内容的条目数量，例如文字稿的轮次（turns）数、面试的问题（questions）数。 */
    itemCount?: number;
    /** 已暴露给模型的字符数：实际展示给下游模型的字符长度；与 characterCount 的差值即被省略（裁剪）的字符数。 */
    exposedCharacterCount?: number;
}

/**
 * Artifact 存储接口：负责保存与读取流水线各阶段的产物。
 *
 * 存储「种类 + 值 + 元数据」三元组，以 id 引用，避免在模型上下文里
 * 反复传递大段文本（例如完整面试文字稿）。
 */
export interface ArtifactStore {
    /**
     * 保存一个 Artifact。
     *
     * @param kind     种类，见 {@link ArtifactKind}
     * @param value    任意类型的值，读取时按原类型返回
     * @param metadata 元数据，见 {@link ArtifactMetadata}
     * @returns 生成的唯一 id（UUID），供后续 {@link get} 使用
     */
    put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string;
    /**
     * 读取一个 Artifact。
     *
     * @param id           {@link put} 返回的 id
     * @param expectedKind 期望的种类，与实际种类不一致时抛出异常
     * @param consumer     消费者名称，仅用于观测（如 "parse_transcript"）
     * @returns 存储时的原始值，按 T 类型返回
     * @throws ArtifactAccessError 当 id 不存在或种类不匹配时
     */
    get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T;
}

/**
 * Artifact 访问错误：id 不存在（未保存或已失效）或种类不匹配时抛出。
 */
export class ArtifactAccessError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ArtifactAccessError";
    }
}
