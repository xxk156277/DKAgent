import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { copySpan, isValidSpan, sameSpanIdentity } from "./span-codec.js";
import { createTraceDocument } from "./trace-document.js";
import type {
    AnyTraceSpan, SpanChange, SpanStatus, TraceDocument, TraceListener, TraceReader, TraceStore, TraceSummary,
} from "./types.js";

interface SpanRow {
    schema_version: number;
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    name: string;
    kind: string;
    status: string;
    sequence: number;
    revision: number;
    started_at: string;
    ended_at: string | null;
    duration_ms: number | null;
    input_json: string;
    output_json: string;
    error_json: string | null;
    token_usage_json: string | null;
    attributes_json: string;
    events_json: string;
    integrity: number;
    session_id: string | null;
}

interface TraceRow {
    trace_id: string;
    session_id: string | null;
    root_span_id: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    integrity: number;
    span_count: number;
    duration_ms: number | null;
}

function validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new Error("Trace Store limit 必须是 1～1000 的整数");
    }
}

function validateSummaryLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("Trace summary limit 必须是 1～100 的整数");
    }
}

export class SqliteTraceStore implements TraceStore, TraceReader {
    private readonly database: Database.Database;
    private readonly listeners = new Set<TraceListener>();
    private closed = false;

    public constructor(databasePath: string) {
        if (databasePath !== ":memory:") {
            const absolutePath = resolve(databasePath);
            mkdirSync(dirname(absolutePath), { recursive: true });
        }
        this.database = new Database(databasePath);
        this.database.pragma("foreign_keys = ON");
        this.database.pragma("journal_mode = WAL");
        this.database.exec(`
            CREATE TABLE IF NOT EXISTS traces (
                trace_id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                root_span_id TEXT NOT NULL UNIQUE,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL,
                revision INTEGER NOT NULL,
                integrity INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS trace_spans (
                span_id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
                parent_span_id TEXT,
                schema_version INTEGER NOT NULL,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                duration_ms REAL,
                input_json TEXT NOT NULL,
                output_json TEXT NOT NULL,
                error_json TEXT,
                token_usage_json TEXT,
                attributes_json TEXT NOT NULL,
                events_json TEXT NOT NULL,
                integrity INTEGER NOT NULL,
                UNIQUE(trace_id, sequence)
            );

            CREATE INDEX IF NOT EXISTS idx_traces_session_started
                ON traces(session_id, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_sequence
                ON trace_spans(trace_id, sequence);
            CREATE INDEX IF NOT EXISTS idx_trace_spans_parent
                ON trace_spans(parent_span_id);
        `);
    }

    public upsert(span: AnyTraceSpan): void {
        if (this.closed || !isValidSpan(span)) return;
        const next = copySpan(span);
        const write = this.database.transaction((): { current: AnyTraceSpan | undefined; changed: boolean } => {
            const current = this.getBySpanId(next.spanId);
            if (current && (current.revision >= next.revision
                || current.status !== "running" && next.status === "running"
                || !sameSpanIdentity(current, next))) return { current, changed: false };

            if (next.name === "agent.turn") {
                if (next.parentSpanId !== undefined || next.sequence !== 1) return { current, changed: false };
                this.upsertTrace(next);
            } else if (!this.traceExists(next.traceId)) {
                return { current, changed: false };
            }

            if (current) this.updateSpan(next);
            else this.insertSpan(next);
            if (next.name !== "agent.turn" && !next.integrity) {
                this.database.prepare("UPDATE traces SET integrity = 0 WHERE trace_id = ?").run(next.traceId);
            }
            return { current, changed: true };
        });

        const result = write();
        if (!result.changed) return;
        const type: SpanChange["type"] = result.current === undefined
            ? next.status === "running" ? "span_started" : "span_ended"
            : next.status === "running" ? "span_updated" : "span_ended";
        for (const listener of this.listeners) {
            try { listener({ type, traceId: next.traceId, span: copySpan(next) }); } catch { /* passive listener */ }
        }
    }

    public list(limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        const rows = this.database.prepare(`
            SELECT s.*, t.session_id
            FROM trace_spans s
            JOIN traces t ON t.trace_id = s.trace_id
            ORDER BY s.rowid DESC
            LIMIT ?
        `).all(limit) as SpanRow[];
        return rows.reverse().map(decodeSpanRow);
    }

    public listByTrace(traceId: string, limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        const rows = this.database.prepare(`
            SELECT s.*, t.session_id
            FROM trace_spans s
            JOIN traces t ON t.trace_id = s.trace_id
            WHERE s.trace_id = ?
            ORDER BY s.sequence ASC
            LIMIT ?
        `).all(traceId, limit) as SpanRow[];
        return rows.map(decodeSpanRow);
    }

    public listBySession(sessionId?: string, limit = 100): AnyTraceSpan[] {
        validateLimit(limit);
        const rows = this.database.prepare(`
            SELECT s.*, t.session_id
            FROM trace_spans s
            JOIN traces t ON t.trace_id = s.trace_id
            WHERE t.session_id ${sessionId === undefined ? "IS NULL" : "= ?"}
            ORDER BY t.started_at ASC, s.sequence ASC
            LIMIT ?
        `).all(...(sessionId === undefined ? [limit] : [sessionId, limit])) as SpanRow[];
        return rows.map(decodeSpanRow);
    }

    public subscribe(listener: TraceListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public recent(limit = 10): TraceSummary[] {
        validateSummaryLimit(limit);
        const rows = this.database.prepare(`
            SELECT
                t.trace_id, t.session_id, t.root_span_id, t.started_at, t.ended_at,
                t.status, t.integrity, COUNT(s.span_id) AS span_count,
                root.duration_ms AS duration_ms
            FROM traces t
            LEFT JOIN trace_spans s ON s.trace_id = t.trace_id
            LEFT JOIN trace_spans root ON root.span_id = t.root_span_id
            GROUP BY t.trace_id
            ORDER BY t.started_at DESC, t.created_at DESC, t.rowid DESC
            LIMIT ?
        `).all(limit) as TraceRow[];
        return rows.map(decodeTraceSummary);
    }

    public listTraceSummariesBySession(sessionId: string, limit = 100): TraceSummary[] {
        validateSummaryLimit(limit);
        const rows = this.database.prepare(`
            SELECT
                t.trace_id, t.session_id, t.root_span_id, t.started_at, t.ended_at,
                t.status, t.integrity, COUNT(s.span_id) AS span_count,
                root.duration_ms AS duration_ms
            FROM traces t
            LEFT JOIN trace_spans s ON s.trace_id = t.trace_id
            LEFT JOIN trace_spans root ON root.span_id = t.root_span_id
            WHERE t.session_id = ?
            GROUP BY t.trace_id
            ORDER BY t.started_at DESC, t.created_at DESC, t.rowid DESC
            LIMIT ?
        `).all(sessionId, limit) as TraceRow[];
        return rows.map(decodeTraceSummary);
    }

    public hasTraceForSession(sessionId: string): boolean {
        return this.database.prepare("SELECT 1 FROM traces WHERE session_id = ? LIMIT 1").get(sessionId) !== undefined;
    }

    public getTraceDocument(traceId: string): TraceDocument | null {
        const row = this.database.prepare(`
            SELECT
                t.trace_id, t.session_id, t.root_span_id, t.started_at, t.ended_at,
                t.status, t.integrity, COUNT(s.span_id) AS span_count,
                root.duration_ms AS duration_ms
            FROM traces t
            LEFT JOIN trace_spans s ON s.trace_id = t.trace_id
            LEFT JOIN trace_spans root ON root.span_id = t.root_span_id
            WHERE t.trace_id = ?
            GROUP BY t.trace_id
        `).get(traceId) as TraceRow | undefined;
        if (!row) return null;

        const spanRows = this.database.prepare(`
            SELECT s.*, t.session_id
            FROM trace_spans s
            JOIN traces t ON t.trace_id = s.trace_id
            WHERE s.trace_id = ?
            ORDER BY s.sequence ASC
            LIMIT 1001
        `).all(traceId) as SpanRow[];
        const spans = spanRows.map(decodeSpanRow);
        const trace = decodeTraceSummary(row);
        return createTraceDocument(trace, spans, row.root_span_id);
    }

    public close(): void {
        if (this.closed) return;
        this.closed = true;
        this.listeners.clear();
        this.database.pragma("wal_checkpoint(TRUNCATE)");
        this.database.close();
    }

    private traceExists(traceId: string): boolean {
        return this.database.prepare("SELECT 1 FROM traces WHERE trace_id = ?").get(traceId) !== undefined;
    }

    private getBySpanId(spanId: string): AnyTraceSpan | undefined {
        const row = this.database.prepare(`
            SELECT s.*, t.session_id
            FROM trace_spans s
            JOIN traces t ON t.trace_id = s.trace_id
            WHERE s.span_id = ?
        `).get(spanId) as SpanRow | undefined;
        return row ? decodeSpanRow(row) : undefined;
    }

    private upsertTrace(span: AnyTraceSpan): void {
        this.database.prepare(`
            INSERT INTO traces (
                trace_id, session_id, root_span_id, started_at, ended_at,
                status, revision, integrity, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(trace_id) DO UPDATE SET
                ended_at = excluded.ended_at,
                status = excluded.status,
                revision = excluded.revision,
                integrity = MIN(traces.integrity, excluded.integrity)
            WHERE traces.root_span_id = excluded.root_span_id
              AND traces.session_id IS excluded.session_id
              AND traces.revision < excluded.revision
        `).run(
            span.traceId, span.sessionId ?? null, span.spanId, span.startedAt, span.endedAt ?? null,
            span.status, span.revision, span.integrity ? 1 : 0, new Date().toISOString(),
        );
    }

    private insertSpan(span: AnyTraceSpan): void {
        this.database.prepare(`
            INSERT INTO trace_spans (
                span_id, trace_id, parent_span_id, schema_version, name, kind, status,
                sequence, revision, started_at, ended_at, duration_ms, input_json,
                output_json, error_json, token_usage_json, attributes_json, events_json, integrity
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(...encodeSpan(span));
    }

    private updateSpan(span: AnyTraceSpan): void {
        this.database.prepare(`
            UPDATE trace_spans SET
                status = ?, revision = ?, ended_at = ?, duration_ms = ?, input_json = ?,
                output_json = ?, error_json = ?, token_usage_json = ?, attributes_json = ?,
                events_json = ?, integrity = ?
            WHERE span_id = ?
        `).run(
            span.status, span.revision, span.endedAt ?? null, span.durationMs ?? null,
            JSON.stringify(span.input), JSON.stringify(span.output),
            span.error === undefined ? null : JSON.stringify(span.error),
            span.tokenUsage === null ? null : JSON.stringify(span.tokenUsage),
            JSON.stringify(span.attributes), JSON.stringify(span.events), span.integrity ? 1 : 0,
            span.spanId,
        );
    }
}

function encodeSpan(span: AnyTraceSpan): unknown[] {
    return [
        span.spanId, span.traceId, span.parentSpanId ?? null, span.schemaVersion, span.name, span.kind,
        span.status, span.sequence, span.revision, span.startedAt, span.endedAt ?? null, span.durationMs ?? null,
        JSON.stringify(span.input), JSON.stringify(span.output),
        span.error === undefined ? null : JSON.stringify(span.error),
        span.tokenUsage === null ? null : JSON.stringify(span.tokenUsage),
        JSON.stringify(span.attributes), JSON.stringify(span.events), span.integrity ? 1 : 0,
    ];
}

function decodeSpanRow(row: SpanRow): AnyTraceSpan {
    const span = {
        schemaVersion: row.schema_version,
        traceId: row.trace_id,
        spanId: row.span_id,
        ...(row.parent_span_id === null ? {} : { parentSpanId: row.parent_span_id }),
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        name: row.name,
        kind: row.kind,
        status: row.status,
        sequence: row.sequence,
        revision: row.revision,
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        input: JSON.parse(row.input_json),
        output: JSON.parse(row.output_json),
        ...(row.error_json === null ? {} : { error: JSON.parse(row.error_json) }),
        tokenUsage: row.token_usage_json === null ? null : JSON.parse(row.token_usage_json),
        attributes: JSON.parse(row.attributes_json),
        events: JSON.parse(row.events_json),
        integrity: row.integrity === 1,
    } as AnyTraceSpan;
    if (!isValidSpan(span)) throw new Error(`不支持的 Trace Span 数据：${row.span_id}`);
    return copySpan(span);
}

function decodeTraceSummary(row: TraceRow): TraceSummary {
    if (row.status !== "running" && row.status !== "ok" && row.status !== "error") {
        throw new Error(`Trace ${row.trace_id} 状态数据不受支持`);
    }
    return {
        traceId: row.trace_id,
        ...(row.session_id === null ? {} : { sessionId: row.session_id }),
        status: row.status as SpanStatus,
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        spanCount: row.span_count,
        integrity: row.integrity === 1,
    };
}
