import { join, parse } from "node:path";
import type { ReadFileInput, ReadFileOutput } from "../tools/filesystem/read-file.js";
import type { WriteFileInput, WriteFileOutput } from "../tools/filesystem/write-file.js";
import type { Tool, ToolContext } from "../tools/types.js";

export async function readWholeText(
    tool: Tool<ReadFileInput, ReadFileOutput>,
    path: string,
    context: ToolContext,
    pageSize = 500,
): Promise<{ path: string; content: string; totalLines: number }> {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
        throw new Error("pageSize 必须是正整数");
    }
    const pages: string[] = [];
    let offset = 1;
    let resolvedPath = path;
    let totalLines = 0;
    while (true) {
        const result = await tool.execute({ path, offset, limit: pageSize }, context);
        if (!result.success || !result.data) {
            throw new Error(result.error?.message ?? "文件读取失败");
        }
        resolvedPath = result.data.path;
        totalLines = result.data.totalLines;
        pages.push(result.data.content);
        if (result.data.endLine >= totalLines) break;
        offset = result.data.endLine + 1;
    }
    return { path: resolvedPath, content: pages.join("\n"), totalLines };
}

function formatLocalTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, "0");
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        "-",
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
    ].join("");
}

export async function writeTimestampedInterviewReport(input: {
    tool: Tool<WriteFileInput, WriteFileOutput>;
    transcriptPath: string;
    markdown: string;
    context: ToolContext;
    now: Date;
}): Promise<string> {
    const parsed = parse(input.transcriptPath);
    const base = join(
        parsed.dir,
        `${parsed.name}-面试分析-${formatLocalTimestamp(input.now)}`,
    );
    for (let attempt = 1; attempt <= 100; attempt += 1) {
        const path = `${base}${attempt === 1 ? "" : `-${attempt}`}.md`;
        const result = await input.tool.execute({
            path,
            content: input.markdown,
            overwrite: false,
        }, input.context);
        if (result.success && result.data) return result.data.path;
        if (!result.error?.message.startsWith("目标文件已存在:")) {
            throw new Error(result.error?.message ?? "报告写入失败");
        }
    }
    throw new Error("同一时间戳下的报告文件冲突过多");
}
