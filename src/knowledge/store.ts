import Database from 'better-sqlite3';
import { KnowledgeEntry, SearchOptions, SearchResult } from './types';

export class KnowledgeStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.initSchema();
    }

    private initSchema(): void {
        this.db.exec(SCHEMA_SQL); // 上面的 schema.sql
    }

    insertBatch(entries: KnowledgeEntry[]): void {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO knowledge
        (id, dimension, dimension_label, question, source, novice_answer, expert_answer, gap_analysis, keywords, embedding)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const tx = this.db.transaction((items: KnowledgeEntry[]) => {
            for (const e of items) {
                stmt.run(
                    e.id,
                    e.dimension,
                    e.dimensionLabel,
                    e.question,
                    e.source ?? null,
                    e.noviceAnswer,
                    e.expertAnswer,
                    e.gapAnalysis,
                    JSON.stringify(e.keywords),
                    e.embedding ? Buffer.from(e.embedding.buffer) : null,
                );
            }
        });

        tx(entries);
        console.log(`Stored ${entries.length} entries`);
    }

    getEntry(id: string): KnowledgeEntry | null {
        const row = this.db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id);
        return row ? this.rowToEntry(row) : null;
    }

    getDimensions(): Array<{ id: string; label: string; count: number }> {
        return this.db.prepare(`
      SELECT dimension as id, dimension_label as label, COUNT(*) as count
      FROM knowledge GROUP BY dimension ORDER BY dimension
    `).all() as any;
    }

    getStats(): { totalEntries: number; dimensions: number; withEmbedding: number } {
        const total = this.db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as any;
        const dims = this.db.prepare('SELECT COUNT(DISTINCT dimension) as c FROM knowledge').get() as any;
        const embedded = this.db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE embedding IS NOT NULL').get() as any;
        return {
            totalEntries: total.c,
            dimensions: dims.c,
            withEmbedding: embedded.c,
        };
    }

    sampleQuestions(opts: { dimension?: string; count: number }): KnowledgeEntry[] {
        let sql = 'SELECT * FROM knowledge';
        const params: any[] = [];

        if (opts.dimension) {
            sql += ' WHERE dimension = ?';
            params.push(opts.dimension);
        }

        sql += ' ORDER BY RANDOM() LIMIT ?';
        params.push(opts.count);

        const rows = this.db.prepare(sql).all(...params);
        return rows.map(r => this.rowToEntry(r));
    }

    private rowToEntry(row: any): KnowledgeEntry {
        return {
            id: row.id,
            dimension: row.dimension,
            dimensionLabel: row.dimension_label,
            question: row.question,
            source: row.source,
            noviceAnswer: row.novice_answer,
            expertAnswer: row.expert_answer,
            gapAnalysis: row.gap_analysis,
            keywords: JSON.parse(row.keywords),
            embedding: row.embedding ? new Float32Array(row.embedding.buffer) : undefined,
        };
    }
}