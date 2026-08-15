import { globbyStream } from "globby";
import type { Tool, ToolResult } from "../types.js";
import { toolFailure } from "./error.js";
import { resolveToolPath } from "./path.js";

export interface FindFilesInput {
    pattern: string;
    path?: string;
    limit?: number;
}

export interface FindFilesOutput {
    path: string;
    files: string[];
    total: number;
}

const DEFAULT_LIMIT = 1000;

function createAbortError(): Error {
    const error = new Error("操作已中止");
    error.name = "AbortError";
    return error;
}

export function createFindFilesTool(cwd: string): Tool<FindFilesInput, FindFilesOutput> {
    return {
        name: "find_files",
        description: "根据 glob 查找文件，默认尊重 .gitignore。",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "glob，例如 **/*.ts" },
                path: { type: "string", description: "搜索目录，默认 cwd" },
                limit: { type: "integer", minimum: 1, description: "最多返回数量，默认 1000" },
            },
            required: ["pattern"],
            additionalProperties: false,
        },
        async execute(input, ctx): Promise<ToolResult<FindFilesOutput>> {
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

                const stream = globbyStream(input.pattern, {
                    cwd: path,
                    gitignore: true,
                    onlyFiles: true,
                    dot: true,
                    followSymbolicLinks: false,
                    expandDirectories: false,
                });
                const iterator = stream[Symbol.asyncIterator]();
                let aborted = false;
                const abort = () => {
                    aborted = true;
                    void iterator.return?.();
                };
                ctx.abortSignal.addEventListener("abort", abort, { once: true });

                const files: string[] = [];
                try {
                    while (files.length < limit) {
                        const next = await iterator.next();
                        if (aborted || ctx.abortSignal.aborted) throw createAbortError();
                        if (next.done) break;
                        files.push(next.value);
                    }
                } finally {
                    ctx.abortSignal.removeEventListener("abort", abort);
                    if (aborted || files.length === limit) await iterator.return?.();
                }

                return { success: true, data: { path, files, total: files.length } };
            } catch (error) {
                const failure = toolFailure(ctx.abortSignal.aborted ? createAbortError() : error);
                if (failure.error?.message.includes("ENOENT")) {
                    failure.error.message = "未找到 ripgrep，请先安装 rg";
                }
                return failure;
            }
        },
    };
}
