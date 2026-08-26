import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { EMBEDDINGS_TABLE_SQL, KNOWLEDGE_FTS_SQL, KNOWLEDGE_TABLE_SQL, KNOWLEDGE_TRIGGERS_SQL } from "./schema.js";

/**
 * 打开知识库数据库连接。
 *
 * 如果数据库目录不存在，会自动创建。
 */
export function openKnowledgeDatabase(databasePath: string): Database.Database {
    if (databasePath !== ":memory:") {
        const absolutePath = resolve(databasePath);

        mkdirSync(dirname(absolutePath), {
            recursive: true,
        });
    }

    const database = new Database(databasePath);

    // SQLite 默认不启用外键；开启后删除知识会同步删除对应向量。
    database.pragma("foreign_keys = ON");
    // WAL 允许读取和写入更好地并发。
    database.pragma("journal_mode = WAL");

    return database;
}

/**
 * 初始化知识表、FTS5 索引和同步 Trigger。
 */
export function initializeKnowledgeSchema(database: Database.Database): void {
    database.exec(KNOWLEDGE_TABLE_SQL);
    database.exec(KNOWLEDGE_FTS_SQL);
    database.exec(KNOWLEDGE_TRIGGERS_SQL);
    database.exec(EMBEDDINGS_TABLE_SQL);
}
