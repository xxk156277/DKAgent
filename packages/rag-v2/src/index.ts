import type { EvidenceSource } from "./generation/context.js";
import { buildEvidenceBundle } from "./generation/context.js";
import { EmbeddingService } from "./embedding/embedding.js";
import { searchKnowledge } from "./retrieval/search.js";
import { RagDatabase } from "./storage/database.js";

/** RAG 查询返回的一条可追溯证据。 */
export interface RagEvidenceSource extends EvidenceSource {
    /** Dense 余弦相似度，仅用于诊断，不代表答案正确概率。 */
    similarity: number;
    /** 当前证据是否依赖尚未理解的图片内容。 */
    needsVision: boolean;
}

/** 提供给 Agent Tool 的只读查询结果。 */
export interface RagQueryResult {
    /** 带 `[n] 路径#标题` 的上下文文本。 */
    evidence: string;
    /** 与编号文本对应的结构化来源。 */
    sources: RagEvidenceSource[];
    /** 检索阶段耗时。 */
    durationMs: number;
    /** 本次查询 Embedding 用量；服务未返回时为空。 */
    embeddingTokens?: number | undefined;
}

/** 创建服务所需的显式配置，避免公共入口读取 Agent 的环境变量。 */
export interface RagKnowledgeServiceOptions {
    databaseUrl: string;
    embedding: {
        apiKey: string;
        baseUrl: string;
        model: string;
        dimensions?: number | undefined;
    };
}

/**
 * RAG v2 的应用级只读入口：混合检索后组装最多 6000 字符的编号证据。
 * 最终答案仍由调用方 Agent 生成，避免一次问题触发两套生成链路。
 */
export class RagKnowledgeService {
    private readonly database: RagDatabase;
    private readonly embedding: EmbeddingService;

    constructor(options: RagKnowledgeServiceOptions) {
        this.database = new RagDatabase(options.databaseUrl);
        this.embedding = new EmbeddingService(
            options.embedding,
            options.embedding.dimensions ?? 1024,
        );
    }

    async query(query: string, topK = 3): Promise<RagQueryResult> {
        const searched = await searchKnowledge({
            database: this.database,
            embedding: this.embedding,
            query,
            topK,
            strategy: "hybrid",
        });
        const bundle = await buildEvidenceBundle(this.database, searched.hits, 6000);
        const hitByIndex = new Map(searched.hits.map((hit, index) => [index + 1, hit]));
        const sources = bundle.sources.flatMap((source) => {
            const hit = hitByIndex.get(source.index);
            return hit
                ? [{
                    ...source,
                    similarity: hit.similarity,
                    needsVision: hit.needsVision,
                }]
                : [];
        });

        return {
            evidence: bundle.text,
            sources,
            durationMs: searched.durationMs,
            embeddingTokens: searched.embeddingTokens,
        };
    }

    /** 关闭 PostgreSQL 连接池。 */
    async close(): Promise<void> {
        await this.database.close();
    }
}

export type { RetrievalStrategy, SearchHit } from "./domain/types.js";
