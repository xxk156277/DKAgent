/** 知识库公共 API：调用方无需依赖内部文件布局。 */
export { buildKnowledgeBase } from "./build.js";
export { openKnowledgeDatabase } from "./database.js";
export type { BuildKnowledgeBaseOptions } from "./build.js";
export {
    createEmbeddingProviderFromEnv,
    OpenAICompatibleEmbeddingProvider,
} from "./embedding.js";
export type {
    EmbeddingProvider,
    OpenAICompatibleEmbeddingOptions,
} from "./embedding.js";
export { parseKnowledgeMarkdown } from "./parser.js";
export { KnowledgeRepository } from "./repository.js";
export { cosineSimilarity, KnowledgeSearch } from "./search.js";
export type {
    KnowledgeBuildStats,
    KnowledgeEntry,
    KnowledgeSearchMethod,
    KnowledgeSearchOptions,
    KnowledgeSearchResult,
    ParseKnowledgeResult,
    PendingEmbedding,
    SkippedKnowledgeBlock,
    StoredEmbeddingInput,
    StoredKnowledgeVector,
} from "./types.js";
