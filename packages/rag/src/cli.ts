import "dotenv/config";
import { resolve } from "node:path";
import { buildKnowledgeBase } from "./build.js";
import { createEmbeddingProviderFromEnv } from "./embedding.js";

const sourceDir = process.env.KNOWLEDGE_SOURCE_DIR ?? "learn-agent-interview";
const databasePath = process.env.KNOWLEDGE_DATABASE_PATH ?? "data/knowledge.db";

try {
    const stats = await buildKnowledgeBase({
        sourceDir,
        databasePath,
        embeddingProvider: createEmbeddingProviderFromEnv(),
    });

    // 只输出构建统计，不打印 API Key 等敏感配置。
    console.log("知识库构建完成", {
        ...stats,
        databasePath: resolve(stats.databasePath),
    });
} catch (error) {
    console.error("知识库构建失败：", error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
