import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
    validateMemoryCandidate,
    type MemoryEntry,
    type MemoryListOptions,
    type MemoryStore,
    type MemoryUpsertInput,
} from "./types.js";

/** memories 表查询结果。 */
interface MemoryRow {
    /** Memory 唯一标识。 */
    id: string;
    /** 记忆类别。 */
    type: MemoryEntry["type"];
    /** 同类记忆的语义键。 */
    key: string;
    /** 注入模型的简短事实文本。 */
    content: string;
    /** 记忆写入来源。 */
    source: MemoryEntry["source"];
    /** 产生或最近更新该记忆的 Session。 */
    source_session_id: string;
    /** 首次创建时间。 */
    created_at: string;
    /** 最近更新时间。 */
    updated_at: string;
}

/** 使用 SQLite 持久化跨 Session 的 Memory。 */
export class SqliteMemoryStore implements MemoryStore {
    /** 当前 Memory Store 独占的数据库连接。 */
    private readonly database: Database.Database;

    public constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
        }

        this.database = new Database(databasePath);
        this.database.pragma("journal_mode = WAL");
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                key TEXT NOT NULL,
                content TEXT NOT NULL,
                source TEXT NOT NULL,
                source_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(type, key)
            );

            CREATE INDEX IF NOT EXISTS idx_memories_type_updated
                ON memories(type, updated_at DESC);
        `);
    }

    /** 新建或按 type/key 更新记忆，并保护显式记忆不被自动结果覆盖。 */
    public upsert(input: MemoryUpsertInput): MemoryEntry {
        const candidate = validateMemoryCandidate(input);
        const write = this.database.transaction(() => {
            const existing = this.database.prepare(`
                SELECT
                    id,
                    type,
                    key,
                    content,
                    source,
                    source_session_id,
                    created_at,
                    updated_at
                FROM memories
                WHERE type = ? AND key = ?
            `).get(candidate.type, candidate.key) as MemoryRow | undefined;

            if (existing?.source === "explicit" && input.source === "automatic") {
                return this.toMemoryEntry(existing);
            }

            const timestamp = new Date().toISOString();
            if (!existing) {
                const memory: MemoryEntry = {
                    id: randomUUID(),
                    type: candidate.type,
                    key: candidate.key,
                    content: candidate.content,
                    source: input.source,
                    sourceSessionId: input.sourceSessionId,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                this.database.prepare(`
                    INSERT INTO memories (
                        id,
                        type,
                        key,
                        content,
                        source,
                        source_session_id,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    memory.id,
                    memory.type,
                    memory.key,
                    memory.content,
                    memory.source,
                    memory.sourceSessionId,
                    memory.createdAt,
                    memory.updatedAt,
                );
                return memory;
            }

            this.database.prepare(`
                UPDATE memories
                SET
                    content = ?,
                    source = ?,
                    source_session_id = ?,
                    updated_at = ?
                WHERE id = ?
            `).run(
                candidate.content,
                input.source,
                input.sourceSessionId,
                timestamp,
                existing.id,
            );

            return {
                id: existing.id,
                type: candidate.type,
                key: candidate.key,
                content: candidate.content,
                source: input.source,
                sourceSessionId: input.sourceSessionId,
                createdAt: existing.created_at,
                updatedAt: timestamp,
            };
        });

        return write();
    }

    /** 按更新时间从新到旧列出记忆。 */
    public list(options: MemoryListOptions = {}): MemoryEntry[] {
        const limit = options.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error("Memory list 的 limit 必须是 1～100 的整数");
        }

        const rows = options.type
            ? this.database.prepare(`
                SELECT
                    id,
                    type,
                    key,
                    content,
                    source,
                    source_session_id,
                    created_at,
                    updated_at
                FROM memories
                WHERE type = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `).all(options.type, limit) as MemoryRow[]
            : this.database.prepare(`
                SELECT
                    id,
                    type,
                    key,
                    content,
                    source,
                    source_session_id,
                    created_at,
                    updated_at
                FROM memories
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `).all(limit) as MemoryRow[];

        return rows.map((row) => this.toMemoryEntry(row));
    }

    /** 按 ID 删除记忆，不存在时返回 false。 */
    public delete(id: string): boolean {
        const result = this.database.prepare(`
            DELETE FROM memories
            WHERE id = ?
        `).run(id);

        return result.changes === 1;
    }

    /** 关闭数据库连接。 */
    public close(): void {
        this.database.pragma("wal_checkpoint(TRUNCATE)");
        this.database.close();
    }

    /** 将 memories 表查询结果转换为公开类型。 */
    private toMemoryEntry(row: MemoryRow): MemoryEntry {
        return {
            id: row.id,
            type: row.type,
            key: row.key,
            content: row.content,
            source: row.source,
            sourceSessionId: row.source_session_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
