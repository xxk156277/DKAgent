import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { toolFailure } from "./error.js";
import { resolveToolPath } from "./path.js";

export interface WriteFileInput {
    path: string;
    content: string;
}

export interface WriteFileOutput {
    path: string;
    bytesWritten: number;
    overwritten: boolean;
}

export function createWriteFileTool(cwd: string): Tool<WriteFileInput, WriteFileOutput> {
    return {
        name: "write_file",
        description: "使用 UTF-8 创建或覆盖文本文件，并自动创建父目录。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对 cwd 或绝对文件路径" },
                content: { type: "string", description: "要写入的完整文本内容" },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        async execute(input): Promise<ToolResult<WriteFileOutput>> {
            if (!input.path || typeof input.content !== "string") {
                return {
                    success: false,
                    error: { code: "input_error", message: "path 和 content 必填" },
                };
            }

            const path = resolveToolPath(input.path, cwd);
            try {
                let overwritten = true;
                try {
                    await access(path);
                } catch {
                    overwritten = false;
                }
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, input.content, "utf8");
                return {
                    success: true,
                    data: { path, bytesWritten: Buffer.byteLength(input.content, "utf8"), overwritten },
                };
            } catch (error) {
                return toolFailure(error);
            }
        },
    };
}
