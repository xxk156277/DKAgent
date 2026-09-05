import type { LexicalChunk, RetrievalStrategy, SearchHit } from "../domain/types.js";
import { EmbeddingService } from "../embedding/embedding.js";
import { RagDatabase } from "../storage/database.js";
import { Bm25Index } from "./bm25.js";

/** RRF 的标准平滑常数，避免首位候选权重过大。 */
const RRF_K = 60;
const bm25IndexCache = new WeakMap<LexicalChunk[], Bm25Index>();

/** 同一数据库语料数组只构建一次 BM25；数据库内容变更会返回新的数组并自然失效。 */
function getBm25Index(chunks: LexicalChunk[]): Bm25Index {
    const cached = bm25IndexCache.get(chunks);
    if (cached) return cached;
    const index = new Bm25Index(
        chunks.map((chunk) => ({
            id: chunk.chunkId,
            text: `${chunk.sourcePath}\n${chunk.headingPath.join(" > ")}\n${chunk.content}`,
        })),
    );
    bm25IndexCache.set(chunks, index);
    return index;
}

/** RRF 融合后的子块排名信息。 */
export interface FusedRank {
    id: string;
    denseRank?: number | undefined;
    bm25Rank?: number | undefined;
    rrfScore: number;
}

/**
 * 只使用两路候选的名次做 RRF，不直接混合不可比较的原始分数。
 */
export function reciprocalRankFusion(denseIds: string[], bm25Ids: string[]): FusedRank[] {
    const fused = new Map<string, FusedRank>();
    const addRank = (id: string, rank: number, kind: "dense" | "bm25"): void => {
        const current = fused.get(id) ?? { id, rrfScore: 0 };
        current.rrfScore += 1 / (RRF_K + rank);
        if (kind === "dense") current.denseRank = rank;
        else current.bm25Rank = rank;
        fused.set(id, current);
    };
    denseIds.forEach((id, index) => addRank(id, index + 1, "dense"));
    bm25Ids.forEach((id, index) => addRank(id, index + 1, "bm25"));
    return [...fused.values()].sort(
        (left, right) =>
            right.rrfScore - left.rrfScore ||
            Math.min(left.denseRank ?? Infinity, left.bm25Rank ?? Infinity) -
                Math.min(right.denseRank ?? Infinity, right.bm25Rank ?? Infinity) ||
            left.id.localeCompare(right.id),
    );
}

/**
 * 按父文档聚合去重：每篇文档只保留相似度最高的命中，再按相似度降序取 topK。
 */
export function aggregateByParent(hits: SearchHit[], topK: number): SearchHit[] {
    const bestByParent = new Map<string, SearchHit>();
    for (const hit of hits) {
        const current = bestByParent.get(hit.parentId);
        const score = hit.rrfScore ?? hit.similarity;
        const currentScore = current ? (current.rrfScore ?? current.similarity) : -Infinity;
        if (!current || score > currentScore) bestByParent.set(hit.parentId, hit);
    }
    return [...bestByParent.values()]
        .sort((a, b) => (b.rrfScore ?? b.similarity) - (a.rrfScore ?? a.similarity))
        .slice(0, topK);
}

/**
 * 语义检索：查询向量化 -> 检索最相近子块 -> 按父文档聚合去重后返回。
 */
export async function searchKnowledge(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    query: string;
    topK?: number;
    strategy?: RetrievalStrategy;
}): Promise<{ hits: SearchHit[]; embeddingTokens?: number | undefined; durationMs: number }> {
    const startedAt = performance.now();
    const topK = input.topK ?? 3;
    const strategy = input.strategy ?? "hybrid";
    const embedded = await input.embedding.embedQuery(input.query);
    const candidateLimit = Math.max(24, topK * 8);
    const denseHits = await input.database.searchChildren(embedded.embedding, candidateLimit);
    if (strategy === "dense") {
        return {
            hits: aggregateByParent(
                denseHits.map((hit, index) => ({ ...hit, denseRank: index + 1 })),
                topK,
            ),
            embeddingTokens: embedded.tokens || undefined,
            durationMs: Math.round(performance.now() - startedAt),
        };
    }

    const lexicalChunks = await input.database.getLexicalChunks();
    const bm25Index = getBm25Index(lexicalChunks);
    const bm25Results = bm25Index.search(input.query, candidateLimit);
    const bm25Scores = new Map(bm25Results.map((result) => [result.id, result.score]));
    const fusedRanks = reciprocalRankFusion(
        denseHits.map((hit) => hit.chunkId),
        bm25Results.map((result) => result.id),
    );
    const unionHits = await input.database.scoreChildrenByIds(
        embedded.embedding,
        fusedRanks.map((rank) => rank.id),
    );
    const hitById = new Map(unionHits.map((hit) => [hit.chunkId, hit]));
    const fusedHits = fusedRanks.flatMap((rank) => {
        const hit = hitById.get(rank.id);
        return hit
            ? [
                  {
                      ...hit,
                      denseRank: rank.denseRank,
                      bm25Rank: rank.bm25Rank,
                      bm25Score: bm25Scores.get(rank.id),
                      rrfScore: rank.rrfScore,
                  },
              ]
            : [];
    });

    return {
        hits: aggregateByParent(fusedHits, topK),
        embeddingTokens: embedded.tokens || undefined,
        durationMs: Math.round(performance.now() - startedAt),
    };
}
