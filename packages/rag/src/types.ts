// 一道面试题对应一个知识单元
export interface KnowledgeEntry {
    /** 稳定唯一标识，由相对路径和问题序号生成。 */
    id: string;
    /** 知识所属维度，例如 01-architecture-design。 */
    dimension: string;
    /** 面试问题原文。 */
    question: string;
    /** 知识库提供的参考答案，是后续 RAG 的主要证据。 */
    expertAnswer: string;
    /** 可选的新手回答，用于展示常见错误或能力差距。 */
    noviceAnswer?: string;
    /** 可选的差距分析或题目考察点。 */
    gapAnalysis?: string;
    /** 知识来源相对于知识库根目录的 Markdown 路径。 */
    sourceFile: string;
    /** 用于全文检索的规范化文本，由问题、答案和差距分析组合生成。 */
    content: string;
}

// 未能转换成知识记录的问题块。
export interface SkippedKnowledgeBlock {
    /** 问题块在当前 Markdown 文件中的顺序，从 1 开始。 */
    blockIndex: number;
    /** 能够识别到的问题文本，便于定位源文件内容。 */
    question: string;
    /** 跳过原因，目前只处理缺少高手答案。 */
    reason: "missing_expert_answer";
}

/**
 * 单个 Markdown 文件的解析结果。
 */
export interface ParseKnowledgeResult {
    /** 成功解析出的知识记录。 */
    entries: KnowledgeEntry[];
    /** 因格式或内容不完整而跳过的问题块。 */
    skipped: SkippedKnowledgeBlock[];
}

/**
 * 一次完整离线建库的统计结果。
 */
export interface KnowledgeBuildStats {
    /** 本次扫描到的 Markdown 文件数量。 */
    scannedFiles: number;
    /** 最终写入 SQLite 的知识记录数量。 */
    storedEntries: number;
    /** 因缺少必要内容而跳过的问题数量。 */
    skippedQuestions: number;
    /** 最终知识记录覆盖的维度数量。 */
    dimensions: number;
    /** 本次实际调用 Embedding API 生成的向量数量。 */
    embeddedEntries: number;
    /** 因内容和模型未变化而复用的向量数量。 */
    reusedEmbeddings: number;
    /** 生成的 SQLite 数据库绝对路径。 */
    databasePath: string;
}

/**
 * FTS5 验证查询返回的一条结果。
 */
export interface KnowledgeSearchHit {
    /** 命中的完整知识记录。 */
    entry: KnowledgeEntry;
    /** SQLite FTS5 排名值，数值越小代表匹配程度越高。 */
    rank: number;
}

/** 等待生成或更新向量的知识记录。 */
export interface PendingEmbedding {
    /** 对应 knowledge 表的稳定 ID。 */
    knowledgeId: string;
    /** 发送给 Embedding Provider 的规范化检索文本。 */
    content: string;
    /** 用于判断文本是否变化的 SHA-256 哈希。 */
    contentHash: string;
}

/** 写入 embeddings 表的一条向量记录。 */
export interface StoredEmbeddingInput {
    /** 对应 knowledge 表的稳定 ID。 */
    knowledgeId: string;
    /** Embedding Provider 返回的浮点向量。 */
    vector: number[];
    /** 生成该向量的模型标识。 */
    model: string;
    /** 生成向量时对应的知识内容哈希。 */
    contentHash: string;
}

/** 从数据库读取的一条知识向量。 */
export interface StoredKnowledgeVector {
    /** 向量所属的完整知识记录。 */
    entry: KnowledgeEntry;
    /** 从 Float32 BLOB 解码后的数值向量。 */
    vector: number[];
}

/** 知识库支持的检索策略。 */
export type KnowledgeSearchMethod = "fts" | "embedding" | "hybrid";

/** 一次知识检索的输入参数。 */
export interface KnowledgeSearchOptions {
    /** 用户的原始检索问题。 */
    query: string;
    /** 指定检索策略，默认使用 hybrid。 */
    method?: KnowledgeSearchMethod;
    /** 可选的知识维度过滤条件。 */
    dimension?: string;
    /** 最终返回数量，默认 10。 */
    limit?: number;
}

/** 一条统一的知识检索结果。 */
export interface KnowledgeSearchResult {
    /** 命中的完整知识记录。 */
    entry: KnowledgeEntry;
    /** 该记录来自关键词、语义或两路同时命中。 */
    matchType: KnowledgeSearchMethod;
    /** 当前检索策略用于最终排序的分数，越大越相关。 */
    score: number;
    /** FTS5 的原始 BM25 排名值，越小越相关。 */
    ftsRank?: number;
    /** Embedding 的余弦相似度，范围通常为 -1 到 1。 */
    similarity?: number;
}
