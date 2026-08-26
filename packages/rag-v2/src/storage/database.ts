/**
 * PostgreSQL + pgvector 数据访问层
 *
 * `RagDatabase` 封装知识库的建表迁移与增删查：
 * - migrate：创建 vector 扩展、rag_documents / rag_chunks 表与 HNSW 向量索引
 * - replaceDocument：事务内原子替换某篇文档及其全部子块（含向量）
 * - searchChildren：按向量余弦相似度检索最相近的子块
 * - getDocument / getDocumentByChunk / stats：按标识查询文档与统计信息
 */
import pg from "pg";
import pgvector from "pgvector";
import type { ChildChunk, ParentDocument, SearchHit } from "../domain/types.js";

const { Pool } = pg;

/**
 * 数据库中存储的一篇文档：父文档 + 带序号（sequence）的子块列表。
 */
export interface StoredDocument {
    parent: ParentDocument;
    chunks: Array<ChildChunk & { sequence: number }>;
}

/**
 * RAG 知识库数据访问对象：封装 PostgreSQL（pgvector）的连接、迁移与读写。
 */
export class RagDatabase {
    readonly pool: pg.Pool;

    /**
     * @param connectionString PostgreSQL 连接串
     */
    constructor(connectionString: string) {
        this.pool = new Pool({ connectionString });
    }

    /** 关闭连接池。 */
    async close(): Promise<void> {
        await this.pool.end();
    }

    /**
     * 执行迁移：创建 vector 扩展、rag_documents / rag_chunks 表、
     * 父子序索引与 HNSW 余弦相似度索引。
     */
    async migrate(): Promise<void> {
        await this.pool.query(`
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE IF NOT EXISTS rag_documents (
        id text PRIMARY KEY,
        source_path text UNIQUE NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        content_hash text NOT NULL,
        frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
        modified_at timestamptz NOT NULL,
        indexed_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS rag_chunks (
        id text PRIMARY KEY,
        parent_id text NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
        source_path text NOT NULL,
        sequence integer NOT NULL,
        heading_path text[] NOT NULL DEFAULT '{}',
        heading_ordinal integer NOT NULL,
        split_index integer NOT NULL,
        content text NOT NULL,
        content_hash text NOT NULL,
        image_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
        needs_vision boolean NOT NULL DEFAULT false,
        embedding vector(1024) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS rag_chunks_parent_sequence_idx
        ON rag_chunks(parent_id, sequence);
      CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw_idx
        ON rag_chunks USING hnsw (embedding vector_cosine_ops);
    `);
    }

    /**
     * 读取所有文档的（source_path → content_hash）映射，用于摄入时跳过未变化文档。
     */
    async getContentHashes(): Promise<Map<string, string>> {
        const result = await this.pool.query<{ source_path: string; content_hash: string }>(
            "SELECT source_path, content_hash FROM rag_documents",
        );
        return new Map(result.rows.map((row) => [row.source_path, row.content_hash]));
    }

    /**
     * 事务内原子替换一篇文档：UPSERT 父文档，删除旧子块后批量插入新子块与向量。
     */
    async replaceDocument(document: ParentDocument, chunks: ChildChunk[], embeddings: number[][]): Promise<void> {
        if (chunks.length !== embeddings.length) throw new Error("子块与 Embedding 数量不一致");
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(
                `INSERT INTO rag_documents
          (id, source_path, title, content, content_hash, frontmatter, modified_at, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
         ON CONFLICT (id) DO UPDATE SET
          source_path = EXCLUDED.source_path,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          content_hash = EXCLUDED.content_hash,
          frontmatter = EXCLUDED.frontmatter,
          modified_at = EXCLUDED.modified_at,
          indexed_at = now()`,
                [
                    document.id,
                    document.sourcePath,
                    document.title,
                    document.content,
                    document.contentHash,
                    JSON.stringify(document.frontmatter),
                    document.modifiedAt,
                ],
            );
            await client.query("DELETE FROM rag_chunks WHERE parent_id = $1", [document.id]);
            for (let sequence = 0; sequence < chunks.length; sequence += 1) {
                const chunk = chunks[sequence]!;
                await client.query(
                    `INSERT INTO rag_chunks
            (id, parent_id, source_path, sequence, heading_path, heading_ordinal, split_index,
             content, content_hash, image_refs, needs_vision, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::vector)`,
                    [
                        chunk.id,
                        chunk.parentId,
                        chunk.sourcePath,
                        sequence,
                        chunk.headingPath,
                        chunk.headingOrdinal,
                        chunk.splitIndex,
                        chunk.content,
                        chunk.contentHash,
                        JSON.stringify(chunk.imageRefs),
                        chunk.needsVision,
                        pgvector.toSql(embeddings[sequence]!),
                    ],
                );
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            /**
             * 删除扫描中已不存在的文档（清理被移除的源文件索引）。
             * @returns 删除的文档数
             */
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteMissingDocuments(seenPaths: string[]): Promise<number> {
        if (seenPaths.length === 0) throw new Error("扫描结果为空，拒绝删除既有索引");
        const result = await this.pool.query("DELETE FROM rag_documents WHERE NOT (source_path = ANY($1::text[]))", [
            seenPaths,
            /**
             * 按向量余弦相似度检索最相近的子块，并按相似度降序返回。
             */
        ]);
        return result.rowCount ?? 0;
    }

    async searchChildren(vector: number[], limit: number): Promise<SearchHit[]> {
        const result = await this.pool.query<{
            parent_id: string;
            source_path: string;
            document_title: string;
            chunk_id: string;
            heading_path: string[];
            content: string;
            similarity: number;
            needs_vision: boolean;
        }>(
            `SELECT
        c.parent_id,
        c.source_path,
        d.title AS document_title,
        c.id AS chunk_id,
        c.heading_path,
        c.content,
        1 - (c.embedding <=> $1::vector) AS similarity,
        c.needs_vision
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.parent_id
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
            [pgvector.toSql(vector), limit],
        );
        return result.rows.map((row) => ({
            parentId: row.parent_id,
            sourcePath: row.source_path,
            documentTitle: row.document_title,
            chunkId: row.chunk_id,
            headingPath: row.heading_path,
            content: row.content,
            similarity: Number(row.similarity),
            needsVision: row.needs_vision,
        }));
    }

    /**
     * 按文档 ID 或相对路径查询一篇完整文档（含全部子块）。
     */
    async getDocument(identifier: string): Promise<StoredDocument | undefined> {
        const parentResult = await this.pool.query<{
            id: string;
            source_path: string;
            title: string;
            content: string;
            content_hash: string;
            frontmatter: Record<string, unknown>;
            modified_at: Date;
        }>(
            `SELECT id, source_path, title, content, content_hash, frontmatter, modified_at
       FROM rag_documents WHERE id = $1 OR source_path = $1 LIMIT 1`,
            [identifier],
        );
        const row = parentResult.rows[0];
        if (!row) return undefined;
        const chunksResult = await this.pool.query<{
            id: string;
            parent_id: string;
            source_path: string;
            sequence: number;
            heading_path: string[];
            heading_ordinal: number;
            split_index: number;
            content: string;
            content_hash: string;
            image_refs: ChildChunk["imageRefs"];
            needs_vision: boolean;
        }>(
            `SELECT id, parent_id, source_path, sequence, heading_path, heading_ordinal, split_index,
              content, content_hash, image_refs, needs_vision
       FROM rag_chunks WHERE parent_id = $1 ORDER BY sequence`,
            [row.id],
        );
        return {
            parent: {
                id: row.id,
                sourcePath: row.source_path,
                title: row.title,
                content: row.content,
                contentHash: row.content_hash,
                frontmatter: row.frontmatter,
                modifiedAt: row.modified_at,
            },
            chunks: chunksResult.rows.map((chunk) => ({
                id: chunk.id,
                parentId: chunk.parent_id,
                sourcePath: chunk.source_path,
                sequence: chunk.sequence,
                headingPath: chunk.heading_path,
                headingOrdinal: chunk.heading_ordinal,
                splitIndex: chunk.split_index,
                content: chunk.content,
                contentHash: chunk.content_hash,
                imageRefs: chunk.image_refs,
                needsVision: chunk.needs_vision,
            })),
            /**
             * 根据子块 ID 反查其所属文档。
             */
        };
    }

    async getDocumentByChunk(chunkId: string): Promise<StoredDocument | undefined> {
        const result = await this.pool.query<{ parent_id: string }>(
            "SELECT parent_id FROM rag_chunks WHERE id = $1 LIMIT 1",
            [chunkId],
        );
        /**
         * 汇总统计：文档数、子块数、含图片子块数与最近索引时间。
         */
        return result.rows[0] ? this.getDocument(result.rows[0].parent_id) : undefined;
    }

    async stats(): Promise<Record<string, unknown>> {
        const result = await this.pool.query<{
            documents: string;
            chunks: string;
            vision_chunks: string;
            last_indexed_at: Date | null;
        }>(`SELECT
      (SELECT count(*) FROM rag_documents) AS documents,
      (SELECT count(*) FROM rag_chunks) AS chunks,
      (SELECT count(*) FROM rag_chunks WHERE needs_vision) AS vision_chunks,
      (SELECT max(indexed_at) FROM rag_documents) AS last_indexed_at`);
        const row = result.rows[0]!;
        return {
            documents: Number(row.documents),
            chunks: Number(row.chunks),
            visionChunks: Number(row.vision_chunks),
            lastIndexedAt: row.last_indexed_at,
        };
    }
}
