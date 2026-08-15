import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { toolFailure } from "./error.js";
import { resolveToolPath } from "./path.js";
import { runRipgrep } from "./ripgrep.js";

export interface GrepFilesInput {
    pattern: string;
    path?: string;
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    limit?: number;
}

export interface GrepMatch {
    path: string;
    line: number;
    text: string;
}

export interface GrepFilesOutput {
    path: string;
    matches: GrepMatch[];
    total: number;
}

interface RipgrepMatchEvent {
    type: string;
    data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
    };
}

const DEFAULT_LIMIT = 100;

function createAbortError(): Error {
    const error = new Error("操作已中止");
    error.name = "AbortError";
    return error;
}

function parseMatches(output: string, limit: number): GrepMatch[] {
    const matches: GrepMatch[] = [];
    for (const line of output.split("\n")) {
        if (!line || matches.length === limit) break;
        const event = JSON.parse(line) as RipgrepMatchEvent;
        if (event.type !== "match") continue;

        const path = event.data?.path?.text;
        const text = event.data?.lines?.text;
        const lineNumber = event.data?.line_number;
        if (!path || text === undefined || lineNumber === undefined) continue;

        matches.push({
            path: path.replace(/^\.\//, ""),
            line: lineNumber,
            text: text.replace(/(?:\r\n|\n|\r)$/, ""),
        });
    }
    return matches;
}

export function createGrepFilesTool(cwd: string): Tool<GrepFilesInput, GrepFilesOutput> {
    return {
        name: "grep_files",
        description: "使用 ripgrep 搜索文件内容，返回匹配路径、行号和文本。",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "搜索正则" },
                path: { type: "string", description: "搜索目录或文件，默认 cwd" },
                glob: { type: "string", description: "按 glob 过滤文件" },
                ignoreCase: { type: "boolean", description: "忽略大小写" },
                literal: { type: "boolean", description: "按字面量搜索" },
                limit: { type: "integer", minimum: 1, description: "最多返回数量，默认 100" },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        async execute(input, ctx): Promise<ToolResult<GrepFilesOutput>> {
            const limit = input.limit ?? DEFAULT_LIMIT;
            if (!input.pattern || !Number.isInteger(limit) || limit < 1) {
                return {
                    success: false,
                    error: { code: "input_error", message: "pattern 必填，limit 必须是正整数" },
                };
            }

            const path = resolveToolPath(input.path ?? ".", cwd);
            try {
                if (ctx.abortSignal.aborted) throw createAbortError();
                const pathStat = await stat(path);
                if (ctx.abortSignal.aborted) throw createAbortError();

                const args = ["--json", "--line-number", "--color=never"];
                if (input.glob) args.push("--glob", input.glob);
                if (input.ignoreCase) args.push("--ignore-case");
                if (input.literal) args.push("--fixed-strings");
                args.push("--", input.pattern);

                const searchCwd = pathStat.isDirectory() ? path : dirname(path);
                args.push(pathStat.isDirectory() ? "." : basename(path));

                const output = await runRipgrep(args, searchCwd, ctx.abortSignal);
                if (ctx.abortSignal.aborted) throw createAbortError();
                const matches = parseMatches(output, limit);
                return { success: true, data: { path, matches, total: matches.length } };
            } catch (error) {
                return toolFailure(ctx.abortSignal.aborted ? createAbortError() : error);
            }
        },
    };
}
