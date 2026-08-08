// knowledge/types.ts

export interface KnowledgeEntry {
    id: string;                    // dimension:index 如 "architecture-design:3"
    dimension: string;             // 维度标识
    dimensionLabel: string;        // 维度中文名
    question: string;              // 面试问题
    source?: string;               // 来源（公司/岗位）
    noviceAnswer: string;          // 新手答
    expertAnswer: string;          // 高手答
    gapAnalysis: string;           // 差距在哪
    keywords: string[];            // 从问题中提取的关键词
    embedding?: Float32Array;      // 向量（question + expertAnswer 拼接后编码）
}

export interface SearchOptions {
    dimension?: string;
    limit?: number;
    threshold?: number;            // embedding 相似度阈值
}

export interface SearchResult extends KnowledgeEntry {
    similarity: number;            // 0-1
    matchType: 'fts' | 'embedding' | 'both';
}