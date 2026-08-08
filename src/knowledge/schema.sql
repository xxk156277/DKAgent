CREATE TABLE
    knowledge (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL,
        dimension_label TEXT NOT NULL,
        question TEXT NOT NULL,
        source TEXT,
        novice_answer TEXT NOT NULL,
        expert_answer TEXT NOT NULL,
        gap_analysis TEXT NOT NULL,
        keywords TEXT NOT NULL, -- JSON array
        embedding BLOB, -- Float32Array serialized
        created_at TEXT NOT NULL DEFAULT (datetime ('now'))
    );

-- FTS5 全文索引（对 question + expert_answer + keywords 建索引）
CREATE VIRTUAL TABLE knowledge_fts USING fts5 (
    id,
    question,
    expert_answer,
    keywords,
    content = knowledge,
    content_rowid = rowid,
    tokenize = 'unicode61'
);

-- 触发器：knowledge 表变更时同步 FTS
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
INSERT INTO
    knowledge_fts (rowid, id, question, expert_answer, keywords)
VALUES
    (
        new.rowid,
        new.id,
        new.question,
        new.expert_answer,
        new.keywords
    );

END;

CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
INSERT INTO
    knowledge_fts (
        knowledge_fts,
        rowid,
        id,
        question,
        expert_answer,
        keywords
    )
VALUES
    (
        'delete',
        old.rowid,
        old.id,
        old.question,
        old.expert_answer,
        old.keywords
    );

END;

-- 维度索引（按维度过滤用）
CREATE INDEX idx_knowledge_dimension ON knowledge (dimension);