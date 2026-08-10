import type { EmbeddingProvider } from "./embedding.js";
import type { KnowledgeRepository } from "./repository.js";
import type {
    KnowledgeSearchOptions,
    KnowledgeSearchResult,
} from "./types.js";

interface RankedCandidate extends KnowledgeSearchResult {
    rank: number;
}

/**
 * 提供 FTS、Embedding 和 RRF 混合检索的统一入口。
 */
export class KnowledgeSearch {
    public constructor(
        private readonly repository: KnowledgeRepository,
        private readonly embeddingProvider?: EmbeddingProvider,
    ) {}

    /** 根据 method 执行检索，默认使用混合检索。 */
    public async search(
        options: KnowledgeSearchOptions,
    ): Promise<KnowledgeSearchResult[]> {
        const query = options.query.trim();
        const method = options.method ?? "hybrid";
        const limit = options.limit ?? 10;
        if (!query || limit <= 0) {
            return [];
        }

        if (method === "fts") {
            return this.searchFts(query, limit, options.dimension).map(
                ({ rank: _rank, ...result }) => result,
            );
        }
        if (method === "embedding") {
            return (
                await this.searchEmbedding(query, limit, options.dimension)
            ).map(({ rank: _rank, ...result }) => result);
        }

        // 两路多召回一些候选，再用排名融合，避免直接比较不同量纲的分数。
        const candidateLimit = Math.max(limit * 4, 20);
        const [ftsCandidates, embeddingCandidates] = await Promise.all([
            Promise.resolve(this.searchFts(query, candidateLimit, options.dimension)),
            this.searchEmbedding(query, candidateLimit, options.dimension),
        ]);
        return fuseWithRrf(ftsCandidates, embeddingCandidates, limit);
    }

    private searchFts(
        query: string,
        limit: number,
        dimension?: string,
    ): RankedCandidate[] {
        return this.repository
            .searchFts(query, limit, dimension)
            .map((hit, index) => ({
                entry: hit.entry,
                matchType: "fts" as const,
                // BM25 越小越相关，取负数后统一成“越大越相关”。
                score: -hit.rank,
                ftsRank: hit.rank,
                rank: index + 1,
            }));
    }

    private async searchEmbedding(
        query: string,
        limit: number,
        dimension?: string,
    ): Promise<RankedCandidate[]> {
        if (!this.embeddingProvider) {
            throw new Error("Embedding 检索需要配置 Embedding Provider");
        }

        const [queryVector] = await this.embeddingProvider.embedBatch([query]);
        if (!queryVector) {
            throw new Error("Embedding Provider 未返回查询向量");
        }

        const vectors = this.repository.listStoredVectors(
            this.embeddingProvider.model,
            dimension,
        );
        const ranked = vectors.map(({ entry, vector }) => {
            if (vector.length !== queryVector.length) {
                throw new Error(
                    `查询向量维度不一致：查询 ${queryVector.length}，知识 ${vector.length}`,
                );
            }
            return { entry, similarity: cosineSimilarity(queryVector, vector) };
        });

        return ranked
            .sort(
                (left, right) =>
                    right.similarity - left.similarity ||
                    left.entry.id.localeCompare(right.entry.id),
            )
            .slice(0, limit)
            .map((item, index) => ({
                entry: item.entry,
                matchType: "embedding" as const,
                score: item.similarity,
                similarity: item.similarity,
                rank: index + 1,
            }));
    }
}

/** 计算两个同维向量的余弦相似度。 */
export function cosineSimilarity(left: number[], right: number[]): number {
    if (left.length !== right.length || left.length === 0) {
        throw new Error("余弦相似度要求两个非空且维度一致的向量");
    }

    let dotProduct = 0;
    let leftSquared = 0;
    let rightSquared = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftValue = left[index]!;
        const rightValue = right[index]!;
        dotProduct += leftValue * rightValue;
        leftSquared += leftValue * leftValue;
        rightSquared += rightValue * rightValue;
    }

    const denominator = Math.sqrt(leftSquared) * Math.sqrt(rightSquared);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Reciprocal Rank Fusion：只融合各路名次，不混合 BM25 与余弦原始分数。
 */
function fuseWithRrf(
    ftsCandidates: RankedCandidate[],
    embeddingCandidates: RankedCandidate[],
    limit: number,
): KnowledgeSearchResult[] {
    const fused = new Map<string, KnowledgeSearchResult>();

    for (const candidate of [...ftsCandidates, ...embeddingCandidates]) {
        const existing = fused.get(candidate.entry.id);
        const rrfScore = 1 / (60 + candidate.rank);
        if (!existing) {
            fused.set(candidate.entry.id, {
                entry: candidate.entry,
                matchType: candidate.matchType,
                score: rrfScore,
                ...(candidate.ftsRank === undefined
                    ? {}
                    : { ftsRank: candidate.ftsRank }),
                ...(candidate.similarity === undefined
                    ? {}
                    : { similarity: candidate.similarity }),
            });
            continue;
        }

        existing.score += rrfScore;
        existing.matchType = "hybrid";
        if (candidate.ftsRank !== undefined) {
            existing.ftsRank = candidate.ftsRank;
        }
        if (candidate.similarity !== undefined) {
            existing.similarity = candidate.similarity;
        }
    }

    return [...fused.values()]
        .sort(
            (left, right) =>
                right.score - left.score || left.entry.id.localeCompare(right.entry.id),
        )
        .slice(0, limit);
}
