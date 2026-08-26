import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { ConversationContextState } from "../context/types.js";
import type { AgentMessage } from "../query-engine/provider.js";
import type { SessionSnapshot, SessionStore, SessionSummary } from "./types.js";

/** sessions 表查询结果。 */
interface SessionRow {
    /** Session 唯一标识。 */
    id: string;
    /** 当前历史摘要。 */
    summary: string;
    /** 第一条仍保留原文的消息下标。 */
    first_kept_message_index: number;
    /** Session 创建时间。 */
    created_at: string;
    /** Session 最近更新时间。 */
    updated_at: string;
}

/** session_messages 表查询结果。 */
interface MessageRow {
    /** 完整 AgentMessage 的 JSON 文本。 */
    message_json: string;
}

/** Session 列表元数据查询结果。 */
interface SessionSummaryRow {
    /** Session 唯一标识。 */
    id: string;
    /** Session 创建时间。 */
    created_at: string;
    /** Session 最近更新时间。 */
    updated_at: string;
}

/** 使用 SQLite 持久化普通对话消息和 Context 压缩状态。 */
export class SqliteSessionStore implements SessionStore {
    /** 当前 Session Store 独占的数据库连接。 */
    private readonly database: Database.Database;

    public constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
        }
        /**
         * 
         *  prepare(sql)	    预编译 SQL，返回 Statement 对象
            transaction(fn)	    把函数包成事务（原子执行、失败回滚）
            exec(sql)	        执行整段 SQL 脚本
            pragma(source, options?)	
                                执行 PRAGMA 语句
            close()	            关闭连接
            function / aggregate	
                                注册自定义 SQL 标量函数 / 聚合函数
            backup / serialize / loadExtension / table	
                                备份、序列化、扩展、虚拟表等高级能力
         */
        this.database = new Database(databasePath);
        // 开启 外键约束
        this.database.pragma("foreign_keys = ON");
        // 预写日志 - ，把"写入"先追加到独立的日志文件，再异步合并回主库文件
        this.database.pragma("journal_mode = WAL");
        // 执行sql
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                first_kept_message_index INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id),
                message_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_session
                ON session_messages(session_id, id);
        `);
    }

    /** 创建一个没有消息和摘要的新 Session。 */
    public create(): SessionSnapshot {
        const timestamp = new Date().toISOString();
        const snapshot: SessionSnapshot = {
            id: randomUUID(),
            messages: [],
            contextState: {
                summary: "",
                firstKeptMessageIndex: 0,
            },
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        this.database
            .prepare(
                `
            INSERT INTO sessions (
                id,
                summary,
                first_kept_message_index,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?)
        `,
            )
            .run(snapshot.id, "", 0, timestamp, timestamp);

        return snapshot;
    }

    /** 按更新时间从新到旧列出 Session，不读取消息正文。 */
    public list(): SessionSummary[] {
        const rows = this.database
            .prepare(
                `
            SELECT id, created_at, updated_at
            FROM sessions
            ORDER BY updated_at DESC, rowid DESC
        `,
            )
            .all() as SessionSummaryRow[];

        return rows.map((row) => ({
            id: row.id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    /** 按唯一标识加载 Session 及其完整消息。 */
    public load(sessionId: string): SessionSnapshot | null {
        const row = this.database
            .prepare(
                `
            SELECT
                id,
                summary,
                first_kept_message_index,
                created_at,
                updated_at
            FROM sessions
            WHERE id = ?
        `,
            )
            .get(sessionId) as SessionRow | undefined;

        return row ? this.buildSnapshot(row) : null;
    }

    /** 加载最近更新的 Session 及其完整消息。 */
    public loadLatest(): SessionSnapshot | null {
        const row = this.database
            .prepare(
                `
            SELECT
                id,
                summary,
                first_kept_message_index,
                created_at,
                updated_at
            FROM sessions
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
        `,
            )
            .get() as SessionRow | undefined;

        if (!row) return null;
        return this.buildSnapshot(row);
    }

    /** 以事务方式删除 Session 及其关联消息。 */
    public delete(sessionId: string): boolean {
        const remove = this.database.transaction(() => {
            this.database
                .prepare(
                    `
                DELETE FROM session_messages
                WHERE session_id = ?
            `,
                )
                .run(sessionId);

            const result = this.database
                .prepare(
                    `
                DELETE FROM sessions
                WHERE id = ?
            `,
                )
                .run(sessionId);

            return result.changes === 1;
        });

        return remove();
    }

    /** 以事务方式追加消息并刷新 Session 更新时间。 */
    public appendMessage(sessionId: string, message: AgentMessage): void {
        const timestamp = new Date().toISOString();
        const write = this.database.transaction(() => {
            this.database
                .prepare(
                    `
                INSERT INTO session_messages (
                    session_id,
                    message_json,
                    created_at
                ) VALUES (?, ?, ?)
            `,
                )
                .run(sessionId, JSON.stringify(message), timestamp);
            this.touch(sessionId, timestamp);
        });

        write();
    }

    /** 覆盖保存 Context 压缩状态，不修改原始消息。 */
    public saveContextState(sessionId: string, state: ConversationContextState): void {
        const result = this.database
            .prepare(
                `
            UPDATE sessions
            SET
                summary = ?,
                first_kept_message_index = ?,
                updated_at = ?
            WHERE id = ?
        `,
            )
            .run(state.summary, state.firstKeptMessageIndex, new Date().toISOString(), sessionId);

        if (result.changes !== 1) {
            throw new Error(`Session ${sessionId} 不存在`);
        }
    }

    /** 关闭数据库连接。 */
    public close(): void {
        // 关闭前把 WAL 日志合并回主库文件，并截断 WAL，确保外部工具能看到完整数据。
        this.database.pragma("wal_checkpoint(TRUNCATE)");
        this.database.close();
    }

    /** 将 Session 行和关联消息组装为可恢复快照。 */
    private buildSnapshot(row: SessionRow): SessionSnapshot {
        const messageRows = this.database
            .prepare(
                `
            SELECT message_json
            FROM session_messages
            WHERE session_id = ?
            ORDER BY id ASC
        `,
            )
            .all(row.id) as MessageRow[];

        let messages: AgentMessage[];
        try {
            messages = messageRows.map((messageRow) => JSON.parse(messageRow.message_json) as AgentMessage);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Session ${row.id} 消息数据损坏：${message}`);
        }

        return {
            id: row.id,
            messages,
            contextState: {
                summary: row.summary,
                firstKeptMessageIndex: row.first_kept_message_index,
            },
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /** 刷新 Session 最近更新时间，并校验 Session 存在。 */
    private touch(sessionId: string, timestamp: string): void {
        const result = this.database
            .prepare(
                `
            UPDATE sessions
            SET updated_at = ?
            WHERE id = ?
        `,
            )
            .run(timestamp, sessionId);

        if (result.changes !== 1) {
            throw new Error(`Session ${sessionId} 不存在`);
        }
    }
}
