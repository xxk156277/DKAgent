import { performance } from "node:perf_hooks";
import { buildEmbeddingText, EmbeddingService } from "./embedding.js";
import { RagDatabase } from "./database.js";
import { scanVault } from "./scanner.js";
import type { IngestReport } from "./types.js";

export async function ingestKnowledgeBase(input: {
  database: RagDatabase;
  embedding: EmbeddingService;
  vaultPath: string;
  sourceGlobs: readonly string[];
}): Promise<IngestReport> {
  const startedAt = performance.now();
  const scan = await scanVault(input.vaultPath, input.sourceGlobs);
  const existingHashes = await input.database.getContentHashes();
  let indexedDocuments = 0;
  let unchangedDocuments = 0;
  let chunksEmbedded = 0;
  let embeddingTokens = 0;
  let hasUsage = false;

  for (const document of scan.documents) {
    if (existingHashes.get(document.parent.sourcePath) === document.parent.contentHash) {
      unchangedDocuments += 1;
      continue;
    }
    const texts = document.chunks.map((chunk) => buildEmbeddingText(chunk.headingPath, chunk.content));
    const embedded = await input.embedding.embedDocuments(texts);
    await input.database.replaceDocument(document.parent, document.chunks, embedded.embeddings);
    indexedDocuments += 1;
    chunksEmbedded += document.chunks.length;
    if (embedded.tokens !== undefined) {
      embeddingTokens += embedded.tokens;
      hasUsage = true;
    }
  }

  const activePaths = [
    ...scan.documents.map((document) => document.parent.sourcePath),
    ...scan.retainedPaths,
  ];
  const deletedDocuments = await input.database.deleteMissingDocuments(activePaths);
  return {
    scannedFiles: scan.seenPaths.length,
    indexedDocuments,
    unchangedDocuments,
    deletedDocuments,
    skippedFiles: scan.skippedFiles,
    chunksEmbedded,
    embeddingTokens: hasUsage ? embeddingTokens : undefined,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
