import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { parseMarkdownDocument } from "./parser.js";
import type { ParsedDocument } from "./types.js";

export interface ScanResult {
  documents: ParsedDocument[];
  seenPaths: string[];
  retainedPaths: string[];
  skippedFiles: Array<{ path: string; reason: string }>;
}

export async function scanVault(vaultRoot: string, sourceGlobs: readonly string[]): Promise<ScanResult> {
  const matches = await fg([...sourceGlobs], {
    cwd: vaultRoot,
    onlyFiles: true,
    unique: true,
    dot: false,
    followSymbolicLinks: false,
  });
  const seenPaths = matches.map((value) => value.split(path.sep).join("/")).sort();
  const documents: ParsedDocument[] = [];
  const retainedPaths: string[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];

  for (const sourcePath of seenPaths) {
    const absolutePath = path.join(vaultRoot, sourcePath);
    try {
      const [content, stat] = await Promise.all([fs.readFile(absolutePath, "utf8"), fs.stat(absolutePath)]);
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
