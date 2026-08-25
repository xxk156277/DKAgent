import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
    KnowledgeEntry,
    KnowledgeSearchHit,
    PendingEmbedding,
    StoredEmbeddingInput,
    StoredKnowledgeVector,
} from "./types.js";
import { decodeVector, encodeVector } from "./vector.js";

interface KnowledgeRow {
    id: string;
    dimension: string;
    question: string;
    expert_answer: string;
    novice_answer: string | null;
    gap_analysis: string | null;
    source_file: string;
    content: string;
}

interface FtsRow extends KnowledgeRow {
    rank: number;
}

interface EmbeddingStateRow {
    knowledge_id: string;
    model: string;
    content_hash: string;
}

interface VectorRow extends KnowledgeRow {
    vector: Buffer;
    dimensions: number;
}

/**
 * 负责知识、FTS 查询和向量持久化，不处理 Markdown 或网络请求。
 */
export class KnowledgeRepository {
    public constructor(private readonly database: Database.Database) {}

    /**
     * 原子同步当前知识集合：更新现有记录，并删除源文件中已消失的记录。
     */
    public syncEntries(entries: KnowledgeEntry[]): void {
        if (entries.length === 0) {
            throw new Error("解析结果为 0 条知识，拒绝修改现有数据库");
        }

        const sync = this.database.transaction((nextEntries: KnowledgeEntry[]) => {
            const upsert = this.database.prepare(`
                INSERT INTO knowledge (
                    id, dimension, question, expert_answer, novice_answer,
                    gap_analysis, source_file, content
                ) VALUES (
                    @id, @dimension, @question, @expertAnswer, @noviceAnswer,
                    @gapAnalysis, @sourceFile, @content
                )
                ON CONFLICT(id) DO UPDATE SET
                    dimension = excluded.dimension,
                    question = excluded.question,
                    expert_answer = excluded.expert_answer,
                    novice_answer = excluded.novice_answer,
                    gap_analysis = excluded.gap_analysis,
                    source_file = excluded.source_file,
                    content = excluded.content
            `);

            const currentIds = new Set(nextEntries.map((entry) => entry.id));
            const storedIds = this.database
                .prepare("SELECT id FROM knowledge")
                .all() as Array<{ id: string }>;

            for (const entry of nextEntries) {
                upsert.run({
                    ...entry,
                    noviceAnswer: entry.noviceAnswer ?? null,
                    gapAnalysis: entry.gapAnalysis ?? null,
                });
            }

            const remove = this.database.prepare("DELETE FROM knowledge WHERE id = ?");
            for (const row of storedIds) {
                if (!currentIds.has(row.id)) {
                    remove.run(row.id);
                }
            }
        });

        sync(entries);
    }

    /** 返回知识总数。 */
    public count(): number {
        const row = this.database
            .prepare("SELECT count(*) AS count FROM knowledge")
            .get() as { count: number };
        return row.count;
    }

    /** 返回去重后的知识维度数量。 */
    public countDimensions(): number {
        const row = this.database
            .prepare("SELECT count(DISTINCT dimension) AS count FROM knowledge")
            .get() as { count: number };
        return row.count;
    }

    /**
     * 找出当前模型下缺失、内容变化或由其他模型生成的向量。
     */
    public findPendingEmbeddings(model: string): PendingEmbedding[] {
        const entries = this.database
            .prepare("SELECT id, content FROM knowledge ORDER BY id")
            .all() as Array<{ id: string; content: string }>;
        const states = this.database
            .prepare("SELECT knowledge_id, model, content_hash FROM embeddings")
            .all() as EmbeddingStateRow[];
        const stateById = new Map(states.map((state) => [state.knowledge_id, state]));

        return entries.flatMap((entry) => {
            const contentHash = hashContent(entry.content);
            const state = stateById.get(entry.id);
            if (state?.model === model && state.content_hash === contentHash) {
                return [];
            }
            return [{ knowledgeId: entry.id, content: entry.content, contentHash }];
        });
    }

    /** 使用短事务批量保存一组已成功生成的向量。 */
    public saveEmbeddings(records: StoredEmbeddingInput[]): void {
        if (records.length === 0) {
            return;
        }

        const save = this.database.transaction((items: StoredEmbeddingInput[]) => {
            const statement = this.database.prepare(`
                INSERT INTO embeddings (
                    knowledge_id, vector, dimensions, model, content_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, unixepoch())
                ON CONFLICT(knowledge_id) DO UPDATE SET
                    vector = excluded.vector,
                    dimensions = excluded.dimensions,
                    model = excluded.model,
                    content_hash = excluded.content_hash,
                    created_at = excluded.created_at
            `);
            for (const item of items) {
                statement.run(
                    item.knowledgeId,
                    encodeVector(item.vector),
                    item.vector.length,
                    item.model,
                    item.contentHash,
                );
            }
        });

        save(records);
    }

    /** 使用 FTS5 BM25 排名召回关键词候选。 */
    public searchFts(
        query: string,
        limit = 10,
        dimension?: string,
    ): KnowledgeSearchHit[] {
        const normalizedQuery = query.trim();
        if (!normalizedQuery || limit <= 0) {
            return [];
        }

        // 双引号查询把用户输入当作文本短语，避免直接暴露 FTS 操作符。
        const matchQuery = `"${normalizedQuery.replaceAll('"', '""')}"`;
        const dimensionClause = dimension ? "AND k.dimension = @dimension" : "";
        const rows = this.database
            .prepare(`
                SELECT
                    k.id, k.dimension, k.question, k.expert_answer,
                    k.novice_answer, k.gap_analysis, k.source_file, k.content,
                    bm25(knowledge_fts) AS rank
                FROM knowledge_fts
                JOIN knowledge AS k ON k.rowid = knowledge_fts.rowid
                WHERE knowledge_fts MATCH @query
                ${dimensionClause}
                ORDER BY rank ASC, k.id ASC
                LIMIT @limit
            `)
            .all({ query: matchQuery, dimension: dimension ?? null, limit }) as FtsRow[];

        return rows.map((row) => ({ entry: mapKnowledgeRow(row), rank: row.rank }));
    }

    /** 读取当前模型的全部知识向量，供小规模内存余弦排序。 */
    public listStoredVectors(
        model: string,
        dimension?: string,
    ): StoredKnowledgeVector[] {
        const dimensionClause = dimension ? "AND k.dimension = @dimension" : "";
        const rows = this.database
            .prepare(`
                SELECT
                    k.id, k.dimension, k.question, k.expert_answer,
                    k.novice_answer, k.gap_analysis, k.source_file, k.content,
                    e.vector, e.dimensions
                FROM embeddings AS e
                JOIN knowledge AS k ON k.id = e.knowledge_id
                WHERE e.model = @model ${dimensionClause}
                ORDER BY k.id ASC
            `)
            .all({ model, dimension: dimension ?? null }) as VectorRow[];

        return rows.map((row) => ({
            entry: mapKnowledgeRow(row),
            vector: decodeVector(row.vector, row.dimensions),
        }));
    }
}

/** 用规范化内容哈希判断已有向量能否复用。 */
export function hashContent(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function mapKnowledgeRow(row: KnowledgeRow): KnowledgeEntry {
    return {
        id: row.id,
        dimension: row.dimension,
        question: row.question,
        expertAnswer: row.expert_answer,
        ...(row.novice_answer ? { noviceAnswer: row.novice_answer } : {}),
        ...(row.gap_analysis ? { gapAnalysis: row.gap_analysis } : {}),
        sourceFile: row.source_file,
        content: row.content,
    };
}
