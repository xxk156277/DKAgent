
import Database from 'better-sqlite3';

export interface CacheEntry {
    key: string;
    response: string;       // JSON serialized ParsedResponse
    tokensSaved: number;
    createdAt: string;
    expiresAt: string;
}

export class QueryCache {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS query_cache (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        tokens_saved INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    }

    get(key: string): ParsedResponse | null {
        const row = this.db.prepare(
            'SELECT response FROM query_cache WHERE key = ? AND expires_at > datetime("now")'
        ).get(key) as { response: string } | undefined;

        return row ? JSON.parse(row.response) : null;
    }

    set(key: string, response: ParsedResponse, ttlSeconds: number): void {
        this.db.prepare(`
      INSERT OR REPLACE INTO query_cache (key, response, tokens_saved, created_at, expires_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'))
    `).run(key, JSON.stringify(response), response.usage.inputTokens, ttlSeconds);
    }

    generateKey(params: StreamParams): string {
        // 基于 model + messages + tools 生成确定性 hash
        const payload = JSON.stringify({
            model: params.model,
            messages: params.messages,
            tools: params.tools?.map(t => t.name),
            temperature: params.temperature,
        });
        return createHash('sha256').update(payload).digest('hex').slice(0, 16);
    }

    evictExpired(): number {
        const result = this.db.prepare(
            'DELETE FROM query_cache WHERE expires_at <= datetime("now")'
        ).run();
        return result.changes;
    }
}