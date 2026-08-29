import { pathToFileURL } from "node:url";
import { SqliteTraceStore } from "./sqlite-store.js";
import type { AnyTraceSpan, TraceDocument, TraceSummary } from "./types.js";

export interface TraceCliOptions {
    databasePath?: string;
    stdout?: (text: string) => void;
    stderr?: (text: string) => void;
}

const usage = "用法：npm run trace -- recent | show <traceId> [--json]\n";

export function runTraceCli(args: string[], options: TraceCliOptions = {}): number {
    const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
    const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
    const databasePath = options.databasePath ?? ".dkagent/sessions.db";
    let store: SqliteTraceStore | undefined;
    try {
        store = new SqliteTraceStore(databasePath);
        if (args.length === 1 && args[0] === "recent") {
            const traces = store.recent();
            stdout(traces.length === 0 ? "暂无 Trace\n" : `${traces.map(formatSummary).join("\n")}\n`);
            return 0;
        }
        if ((args.length === 2 || args.length === 3)
            && args[0] === "show"
            && args[1]
            && (args.length === 2 || args[2] === "--json")) {
            const document = store.getTraceDocument(args[1]);
            if (!document) {
                stderr(`Trace ${args[1]} 不存在\n`);
                return 1;
            }
            stdout(args[2] === "--json"
                ? `${JSON.stringify(document, null, 2)}\n`
                : formatDocument(document));
            return 0;
        }
        stderr(usage);
        return 1;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        stderr(`Trace 查询失败：${message}\n`);
        return 1;
    } finally {
        try { store?.close(); } catch { /* query close failure cannot hide the result */ }
    }
}

function formatSummary(trace: TraceSummary): string {
    const duration = trace.durationMs === undefined ? "-" : `${trace.durationMs.toFixed(1)}ms`;
    return [
        trace.traceId,
        `status=${trace.status}`,
        `started=${trace.startedAt}`,
        `duration=${duration}`,
        `spans=${trace.spanCount}`,
        `integrity=${trace.integrity ? "ok" : "incomplete"}`,
        `session=${trace.sessionId ?? "-"}`,
    ].join(" ");
}

function formatDocument(document: TraceDocument): string {
    const lines = [
        formatSummary(document.trace),
        `complete=${document.complete}`,
        `diagnostics=${JSON.stringify(document.diagnostics)}`,
    ];
    const byId = new Map(document.spans.map((span) => [span.spanId, span]));
    for (const span of document.spans) lines.push(formatSpan(span, byId));
    return `${lines.join("\n")}\n`;
}

function formatSpan(span: AnyTraceSpan, byId: Map<string, AnyTraceSpan>): string {
    let depth = 0;
    let parentId = span.parentSpanId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) break;
        depth += 1;
        parentId = parent.parentSpanId;
    }
    const duration = span.durationMs === undefined ? "-" : `${span.durationMs.toFixed(1)}ms`;
    const tokens = span.tokenUsage === null
        ? "-"
        : `${span.tokenUsage.inputTokens}/${span.tokenUsage.outputTokens}`;
    return `${"  ".repeat(depth)}${span.sequence} ${span.name} ${span.status} duration=${duration} tokens=${tokens}`;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
    process.exitCode = runTraceCli(process.argv.slice(2));
}
