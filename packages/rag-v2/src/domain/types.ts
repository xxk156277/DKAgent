/**
 * 数据模型与共享类型定义
 *
 * 集中定义 RAG v2 的领域模型，供 parser / database / search / ask 等模块共享：
 * - 文档解析产物：ParentDocument（父文档）、ChildChunk（子块）、ParsedDocument（解析结果）
 * - 检索产物：SearchHit（命中子块）、Citation（来源引用）
 * - 流程统计：IngestReport（摄入报告）
 * - 评估用例：EvaluationQuestion（检索评估问题）
 */

/**
 * 图片引用
 */
export interface ImageReference {
    /** 引用语法类型：`markdown`（![]() 语法）或 `obsidian`（![[ ]] 语法） */
    kind: "markdown" | "obsidian";
    /** 图片目标：Markdown 为链接地址，Obsidian 为 [[目标]] 中的名称/路径 */
    target: string;
    /** 图片替代文本（alt），可选 */
    alt?: string | undefined;
}

/**
 * 父文档：一条源文件的整体记录。
 * 它来自哪里、完整内容是什么、是否发生变化。**
 */
export interface ParentDocument {
    /** 文档稳定 ID：由相对路径生成的 SHA-256 哈希 */
    id: string;
    /** 根目录的源文件路径（正斜杠分隔） */
    sourcePath: string;
    /** 文档标题：首个H1标题||文件名 */
    title: string;
    /** 全文原始内容完整md */
    content: string;
    /** 全文的 SHA-256 哈希，用于摄入时跳过未变化文档 */
    contentHash: string;
    /** frontmatter 元数据（YAML 解析后的键值对） */
    frontmatter: Record<string, unknown>;
    /** 源文件修改时间 */
    modifiedAt: Date;
}

/**
 * 子块：父文档按标题切分出的检索最小单元，携带 heading 路径、序号与图片引用。
 */
export interface ChildChunk {
    /** 子块稳定 ID：由父文档 ID + 标题路径 + 序号生成的 SHA-256 哈希 */
    id: string;
    /** 所属父文档 ID（对应 ParentDocument.id） */
    parentId: string;
    /** 相对 Vault 根目录的源文件路径 */
    sourcePath: string;
    /** 章节标题路径：从 H1 到当前标题，如 ["前端学习", "CSS 布局"] */
    headingPath: string[];
    /** 同级重复标题的序号（从 0 起），用于区分同名的多个标题章节 */
    headingOrdinal: number;
    /** 超长章节二次切分后的分片序号（从 0 起） */
    splitIndex: number;
    /** 子块正文内容 */
    content: string;
    /** 子块正文的 SHA-256 哈希 */
    contentHash: string;
    /** 子块内引用的图片列表 */
    imageRefs: ImageReference[];
    /** 是否需要多模态理解：正文去除图片/标题后可见文字很少时为 true */
    needsVision: boolean;
}

/**
 * 解析结果：一个源文档解析后的父文档 + 子块列表。
 */
export interface ParsedDocument {
    /** 解析出的父文档（整篇） */
    parent: ParentDocument;
    /** 该文档切分出的全部子块 */
    chunks: ChildChunk[];
}

/**
 * 检索命中：语义检索返回的一个子块及其与查询的相似度。
 */
export interface SearchHit {
    /** 命中所属的父文档 ID */
    parentId: string;
    /** 命中所属的源文件路径 */
    sourcePath: string;
    /** 命中所属文档的标题 */
    documentTitle: string;
    /** 命中的子块 ID */
    chunkId: string;
    /** 命中子块的章节标题路径 */
    headingPath: string[];
    /** 命中子块的正文内容 */
    content: string;
    /** 与查询的余弦相似度，理论范围 [-1, 1]，越接近 1 越相关 */
    similarity: number;
    /** 命中子块是否需要多模态理解 */
    needsVision: boolean;
    /** Dense 候选中的名次（从 1 起），未进入 Dense 候选时为空 */
    denseRank?: number | undefined;
    /** BM25 候选中的名次（从 1 起），未进入 BM25 候选时为空 */
    bm25Rank?: number | undefined;
    /** BM25 原始分数，仅用于诊断，不与余弦相似度直接相加 */
    bm25Score?: number | undefined;
    /** RRF 融合分数；Dense-only 检索时为空 */
    rrfScore?: number | undefined;
}

/** 不含向量的词法检索子块，用于构建进程内 BM25 索引。 */
export type LexicalChunk = Omit<SearchHit, "similarity" | "denseRank" | "bm25Rank" | "bm25Score" | "rrfScore">;

/** 检索策略：Dense 基线或 BM25 + Dense + RRF。 */
export type RetrievalStrategy = "dense" | "hybrid";

/**
 * 引用标注：答案中 [n] 对应的来源位置。
 */
export interface Citation {
    /** 引用编号：对应答案中的 [n] 标注 */
    index: number;
    /** 引用来源的源文件路径 */
    sourcePath: string;
    /** 引用来源的章节标题路径 */
    headingPath: string[];
}

/**
 * 摄入报告：一次知识库摄入的统计结果。
 */
export interface IngestReport {
    /** 扫描到的源文件总数 */
    scannedFiles: number;
    /** 实际新索引并写入数据库的文档数 */
    indexedDocuments: number;
    /** 内容未变化、被跳过的文档数 */
    unchangedDocuments: number;
    /** 源文件已不存在、被清理删除的文档数 */
    deletedDocuments: number;
    /** 被跳过的文件列表：path 为相对路径，reason 为跳过原因 */
    skippedFiles: Array<{ path: string; reason: string }>;
    /** 本次摄入写入的向量（子块）总数 */
    chunksEmbedded: number;
    /** Embedding 调用消耗的 token 数（模型未返回用量时为 undefined） */
    embeddingTokens?: number | undefined;
    /** 摄入总耗时（毫秒） */
    durationMs: number;
}

/**
 * 评估问题：一条检索评估用例（含期望命中的源文件、期望事实与是否应拒答）。
 */
export interface EvaluationQuestion {
    /** 评估用的查询问题文本 */
    query: string;
    /** 人工标注的全部相关父文档路径，用于按命中比例计算严格 Recall@K */
    relevantSourcePaths: string[];
    /** 期望答案中出现的事实要点（用于内容校验） */
    expectedFacts: string[];
    /** 是否应拒答：true = 期望系统拒答（测试拒答边界），false = 期望正常回答 */
    shouldRefuse: boolean;
}
