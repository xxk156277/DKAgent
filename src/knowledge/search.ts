import { KnowledgeStore } from './store';
import { SearchOptions, SearchResult, KnowledgeEntry } from './types';
import OpenAI from 'openai';

export class KnowledgeSearch {
    private store: KnowledgeStore;
    private openai: OpenAI;

    constructor(store: KnowledgeStore, openaiApiKey: string) {
        this.store = store;
        this.openai = new OpenAI({ apiKey: openaiApiKey });
    }

    async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
        const { dimension, limit = 3, threshold = 0.5 } = opts;

        // 通道 1: FTS5 全文检索
        const ftsResults = this.searchFTS(query, { dimension, limit: limit * 3 });

        // 通道 2: Embedding 语义检索
        const embeddingResults = await this.searchEmbedding(query, { dimension, limit: limit * 3, threshold });

        // 合并 + 重排序
        return this.mergeResults(ftsResults, embeddingResults, limit);
    }

    searchFTS(query: string, opts: { dimension?: string; limit: number }): SearchResult[] {
        // 构造 FTS5 查询（分词 + OR 连接）
        const tokens = this.tokenize(query);
        const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ');

        let sql = `
      SELECT k.*, rank
      FROM knowledge_fts fts
      JOIN knowledge k ON k.id = fts.id
      WHERE knowledge_fts MATCH ?
    `;
        const params: any[] = [ftsQuery];

        if (opts.dimension) {
            sql += ' AND k.dimension = ?';
            params.push(opts.dimension);
        }

        sql += ' ORDER BY rank LIMIT ?';
        params.push(opts.limit);

        const rows = this.store.db.prepare(sql).all(...params);
        return rows.map((row: any) => ({
            ...this.store.rowToEntry(row),
            similarity: this.normalizeRank(row.rank),
            matchType: 'fts' as const,
        }));
    }

    async searchEmbedding(
        query: string,
        opts: { dimension?: string; limit: number; threshold: number }
    ): Promise<SearchResult[]> {
        // 生成 query embedding
        const response = await this.openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: query,
        });
        const queryVec = new Float32Array(response.data[0].embedding);

        // 从 DB 取出所有候选（有 embedding 的行）
        let sql = 'SELECT * FROM knowledge WHERE embedding IS NOT NULL';
        const params: any[] = [];

        if (opts.dimension) {
            sql += ' AND dimension = ?';
            params.push(opts.dimension);
        }

        const rows = this.store.db.prepare(sql).all(...params);

        // 计算余弦相似度 + 排序
        const scored: Array<{ entry: KnowledgeEntry; similarity: number }> = [];

        for (const row of rows) {
            const entry = this.store.rowToEntry(row);
            if (!entry.embedding) continue;
            const sim = cosineSimilarity(queryVec, entry.embedding);
            if (sim >= opts.threshold) {
                scored.push({ entry, similarity: sim });
            }
        }

        scored.sort((a, b) => b.similarity - a.similarity);

        return scored.slice(0, opts.limit).map(s => ({
            ...s.entry,
            similarity: s.similarity,
            matchType: 'embedding' as const,
        }));
    }

    private mergeResults(
        fts: SearchResult[],
        embedding: SearchResult[],
        limit: number,
    ): SearchResult[] {
        const merged = new Map<string, SearchResult>();

        // embedding 结果优先（语义匹配通常更准）
        for (const r of embedding) {
            merged.set(r.id, r);
        }

        // FTS 结果补充（可能捕获精确匹配）
        for (const r of fts) {
            if (merged.has(r.id)) {
                // 两个通道都命中——提升分数
                const existing = merged.get(r.id)!;
                existing.similarity = Math.min(1.0, existing.similarity * 1.2);
                existing.matchType = 'both';
            } else {
                merged.set(r.id, r);
            }
        }

        // 按 similarity 排序
        return Array.from(merged.values())
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    private tokenize(text: string): string[] {
        // 简单分词：按空格 + 中文字符边界切
        const tokens = text
            .replace(/[，。？！、；：""''（）《》【】]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 2);
        return [...new Set(tokens)];
    }

    private normalizeRank(rank: number): number {
        // FTS5 rank 是负数（越小越好），转成 0-1
        return Math.min(1.0, Math.max(0, 1 + rank / 10));
    }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}