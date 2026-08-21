import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "../types.js";
import { toolFailure } from "./error.js";
import { resolveToolPath } from "./path.js";

export interface ReadFileInput {
    path: string;
    offset?: number;
    limit?: number;
    storeAsArtifact?: boolean;
}

export interface ReadFileOutput {
    path: string;
    content?: string;
    startLine?: number;
    endLine?: number;
    totalLines: number;
    artifactId?: string;
    characterCount?: number;
}

const DEFAULT_LIMIT = 500;

export function createReadFileTool(cwd: string): Tool<ReadFileInput, ReadFileOutput> {
    return {
        name: "read_file",
        description: "读取 UTF-8 文本文件，可指定起始行和最大行数。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对 cwd 或绝对文件路径" },
                offset: { type: "integer", minimum: 1, description: "起始行，从 1 开始" },
                limit: { type: "integer", minimum: 1, description: "最大返回行数，默认 500" },
                storeAsArtifact: {
                    type: "boolean",
                    description: "读取完整文件并仅返回 Artifact 引用，不能与 offset 或 limit 同用",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        async execute(input, context): Promise<ToolResult<ReadFileOutput>> {
            if (input.storeAsArtifact && (input.offset !== undefined || input.limit !== undefined)) {
                return {
                    success: false,
                    error: { code: "input_error", message: "Artifact 模式不能指定 offset 或 limit" },
                };
            }
            if (input.storeAsArtifact && !context.artifactStore) {
                return {
                    success: false,
                    error: { code: "input_error", message: "ArtifactStore 未初始化" },
                };
            }
            const offset = input.offset ?? 1;
            const limit = input.limit ?? DEFAULT_LIMIT;
            if (!input.path || !Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1) {
                return {
                    success: false,
                    error: { code: "input_error", message: "path 必填，offset 和 limit 必须是正整数" },
                };
            }

            const path = resolveToolPath(input.path, cwd);
            try {
                const text = await readFile(path, "utf8");
                const lines = text.split(/\r\n|\n|\r/);
                if (input.storeAsArtifact) {
                    const artifactId = context.artifactStore!.put("file_text", text, {
                        producer: "read_file",
                        characterCount: text.length,
                    });
                    return {
                        success: true,
                        data: {
                            path,
                            artifactId,
                            characterCount: text.length,
                            totalLines: lines.length,
                        },
                    };
                }
                const selected = lines.slice(offset - 1, offset - 1 + limit);
                return {
                    success: true,
                    data: {
                        path,
                        content: selected.join("\n"),
                        startLine: offset,
                        endLine: selected.length === 0 ? offset - 1 : offset + selected.length - 1,
                        totalLines: lines.length,
                    },
                };
            } catch (error) {
                return toolFailure(error);
            }
        },
    };
}
