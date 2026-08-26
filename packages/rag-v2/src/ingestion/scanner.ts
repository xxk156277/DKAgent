import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { parseMarkdownDocument } from "./parser.js";
import type { ParsedDocument } from "../domain/types.js";

/**
 * 扫描结果：解析出的文档、扫描到的路径、需保留旧索引的路径与跳过的文件及原因。
 */
export interface ScanResult {
    documents: ParsedDocument[];
    seenPaths: string[];
    retainedPaths: string[];
    skippedFiles: Array<{ path: string; reason: string }>;
}

/**
 * 扫描 Vault 目录：按 glob 匹配源文件并逐个解析为文档。
 * 读取/解析失败的文件不会删除旧索引（记入 retainedPaths），并记录跳过原因。
 */
export async function scanVault(vaultRoot: string, sourceGlobs: readonly string[]): Promise<ScanResult> {
    // 获取所有符合的文档路径
    const matches = await fg([...sourceGlobs], {
        cwd: vaultRoot,
        onlyFiles: true,
        unique: true,
        dot: false,
        followSymbolicLinks: false,
    });

    // 统一路径分隔符 window是:\（反斜杠）    macOS|Linux:/（正斜杠）
    const seenPaths = matches.map((value) => value.split(path.sep).join("/")).sort();
    const documents: ParsedDocument[] = [];
    const retainedPaths: string[] = [];
    const skippedFiles: Array<{ path: string; reason: string }> = [];

    for (const sourcePath of seenPaths) {
        const absolutePath = path.join(vaultRoot, sourcePath);
        try {
            const [content, stat] = await Promise.all([fs.readFile(absolutePath, "utf8"), fs.stat(absolutePath)]);
            console.log("读取", content, stat);
            const parsed = parseMarkdownDocument(absolutePath, vaultRoot, content, stat.mtime);
            if (parsed.chunks.length === 0) {
                skippedFiles.push({ path: sourcePath, reason: "文档没有可索引文本" });
                continue;
            }
            documents.push(parsed);
        } catch (error) {
            // iCloud 占位文件或临时读失败时保留数据库中的旧版本。
            retainedPaths.push(sourcePath);
            skippedFiles.push({
                path: sourcePath,
                reason: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { documents, seenPaths, retainedPaths, skippedFiles };
}
