/**
 * 知识库 SQL 定义。
 *
 * 把建表 / FTS / Trigger 语句集中在这里，便于单独维护和复用
 * （例如只重建 FTS 索引、排查 SQL 报错等场景）。
 */

/**
 * 知识主表。
 */
export const KNOWLEDGE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL,
        question TEXT NOT NULL,
        expert_answer TEXT NOT NULL,
        novice_answer TEXT,
        gap_analysis TEXT,
        source_file TEXT NOT NULL,
        content TEXT NOT NULL
    );
`;

/**
 * FTS5 全文索引（关联外部表 knowledge，使用 trigram 分词）。
 */
export const KNOWLEDGE_FTS_SQL = `
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        question,
        expert_answer,
        gap_analysis,
        content,
        content = 'knowledge',
        content_rowid = 'rowid',
        tokenize = 'trigram'
    );
`;

/**
 * Embedding 向量表。
 *
 * vector 使用 Float32 BLOB，content_hash 用于避免重复调用外部 API。
 */
export const EMBEDDINGS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS embeddings (
        knowledge_id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        model TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        FOREIGN KEY (knowledge_id) REFERENCES knowledge(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS embeddings_model_idx
    ON embeddings(model);
`;

/**
 * 同步 Trigger：让 FTS 索引与主表保持一致。
 */
export const KNOWLEDGE_TRIGGERS_SQL = `
    CREATE TRIGGER IF NOT EXISTS knowledge_after_insert
    AFTER INSERT ON knowledge
    BEGIN
        INSERT INTO knowledge_fts(
            rowid,
            question,
            expert_answer,
            gap_analysis,
            content
        )
        VALUES (
            new.rowid,
            new.question,
            new.expert_answer,
            new.gap_analysis,
            new.content
        );
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_after_delete
    AFTER DELETE ON knowledge
    BEGIN
        INSERT INTO knowledge_fts(
            knowledge_fts,
            rowid,
            question,
            expert_answer,
            gap_analysis,
            content
        )
        VALUES (
            'delete',
            old.rowid,
            old.question,
            old.expert_answer,
            old.gap_analysis,
            old.content
        );
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_after_update
    AFTER UPDATE ON knowledge
    BEGIN
        INSERT INTO knowledge_fts(
            knowledge_fts,
            rowid,
            question,
            expert_answer,
            gap_analysis,
            content
        )
        VALUES (
            'delete',
            old.rowid,
            old.question,
            old.expert_answer,
            old.gap_analysis,
            old.content
        );

        INSERT INTO knowledge_fts(
            rowid,
            question,
            expert_answer,
            gap_analysis,
            content
        )
        VALUES (
            new.rowid,
            new.question,
            new.expert_answer,
            new.gap_analysis,
            new.content
        );
    END;
`;
