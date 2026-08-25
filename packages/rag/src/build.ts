import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { initializeKnowledgeSchema, openKnowledgeDatabase } from "./database.js";
import type { EmbeddingProvider } from "./embedding.js";
import { parseKnowledgeMarkdown } from "./parser.js";
import { KnowledgeRepository } from "./repository.js";
import type {
    KnowledgeBuildStats,
    KnowledgeEntry,
    StoredEmbeddingInput,
} from "./types.js";

/** 离线知识库构建参数。 */
export interface BuildKnowledgeBaseOptions {
    /** Markdown 知识目录，构建器会递归扫描其中的 `.md` 文件。 */
    sourceDir: string;
    /** SQLite 数据库输出路径。 */
    databasePath: string;
    /** 用于生成真实知识向量的 Provider。 */
    embeddingProvider: EmbeddingProvider;
    /** 单次发送给 Provider 的文本数量，默认 100。 */
    embeddingBatchSize?: number;
}

/**
 * 完成 Markdown 解析、SQLite 同步和增量 Embedding 的离线建库流程。
 */
export async function buildKnowledgeBase(
    options: BuildKnowledgeBaseOptions,
): Promise<KnowledgeBuildStats> {
    const sourceDir = resolve(options.sourceDir);
    const databasePath = resolve(options.databasePath);
    const batchSize = options.embeddingBatchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw new Error("embeddingBatchSize 必须是正整数");
    }

    const markdownFiles = await listMarkdownFiles(sourceDir);
    const entries: KnowledgeEntry[] = [];
    let skippedQuestions = 0;

    // 先完整解析再打开数据库，避免空目录或格式错误覆盖已有知识。
    for (const filePath of markdownFiles) {
        const markdown = await readFile(filePath, "utf8");
        const sourceFile = relative(sourceDir, filePath).replaceAll("\\", "/");
        const parsed = parseKnowledgeMarkdown(markdown, sourceFile);
        entries.push(...parsed.entries);
        skippedQuestions += parsed.skipped.length;
    }

    if (entries.length === 0) {
        throw new Error("扫描结果为 0 条可入库知识，拒绝修改现有数据库");
    }

    const database = openKnowledgeDatabase(databasePath);
    try {
        initializeKnowledgeSchema(database);
        const repository = new KnowledgeRepository(database);
        repository.syncEntries(entries);

        const pending = repository.findPendingEmbeddings(
            options.embeddingProvider.model,
        );
        let embeddedEntries = 0;

        for (let offset = 0; offset < pending.length; offset += batchSize) {
            const batch = pending.slice(offset, offset + batchSize);

            // 网络调用发生在事务之外；每批成功后才用短事务落库。
            const vectors = await options.embeddingProvider.embedBatch(
                batch.map((item) => item.content),
            );
            if (vectors.length !== batch.length) {
                throw new Error(
                    `Embedding 批次返回数量不一致：期望 ${batch.length}，实际 ${vectors.length}`,
                );
            }

            const records: StoredEmbeddingInput[] = batch.map((item, index) => {
                const vector = vectors[index];
                if (!vector) {
                    throw new Error(`Embedding 批次缺少第 ${index + 1} 条向量`);
                }
                return {
                    knowledgeId: item.knowledgeId,
                    vector,
                    model: options.embeddingProvider.model,
                    contentHash: item.contentHash,
                };
            });
            repository.saveEmbeddings(records);
            embeddedEntries += records.length;
        }

        const storedEntries = repository.count();
        return {
            scannedFiles: markdownFiles.length,
            storedEntries,
            skippedQuestions,
            dimensions: repository.countDimensions(),
            embeddedEntries,
            reusedEmbeddings: storedEntries - pending.length,
            databasePath,
        };
    } finally {
        database.close();
    }
}

/** 递归读取目录，并以稳定顺序返回所有 Markdown 文件。 */
async function listMarkdownFiles(directory: string): Promise<string[]> {
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const directoryEntry of directoryEntries.sort((left, right) =>
        left.name.localeCompare(right.name),
    )) {
        const entryPath = resolve(directory, directoryEntry.name);
        if (directoryEntry.isDirectory()) {
            files.push(...(await listMarkdownFiles(entryPath)));
        } else if (directoryEntry.isFile() && directoryEntry.name.endsWith(".md")) {
            files.push(entryPath);
        }
    }

    return files;
}
