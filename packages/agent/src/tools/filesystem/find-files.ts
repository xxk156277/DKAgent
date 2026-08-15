import { matchesGlob } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { toolFailure } from "./error.js";
import { resolveToolPath } from "./path.js";
import { runRipgrep } from "./ripgrep.js";

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
                const result = await runRipgrep(["--files", "--no-require-git"], path, ctx.abortSignal);
                const files = result.stdout
                    .split("\n")
                    .filter((file) => file && matchesGlob(file, input.pattern))
                    .slice(0, limit);
                return { success: true, data: { path, files, total: files.length } };
            } catch (error) {
                const failure = toolFailure(error);
                if (failure.error?.message.includes("ENOENT")) {
                    failure.error.message = "未找到 ripgrep，请先安装 rg";
                }
                return failure;
            }
        },
    };
}
