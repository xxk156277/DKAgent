import type { SearchHit } from "./types.js";
import { EmbeddingService } from "./embedding.js";
import { RagDatabase } from "./database.js";

export function aggregateByParent(hits: SearchHit[], topK: number): SearchHit[] {
  const bestByParent = new Map<string, SearchHit>();
  for (const hit of hits) {
    const current = bestByParent.get(hit.parentId);
    if (!current || hit.similarity > current.similarity) bestByParent.set(hit.parentId, hit);
  }
  return [...bestByParent.values()].sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

export async function searchKnowledge(input: {
  database: RagDatabase;
  embedding: EmbeddingService;
  query: string;
  topK?: number;
}): Promise<{ hits: SearchHit[]; embeddingTokens?: number; durationMs: number }> {
  const startedAt = performance.now();
  const topK = input.topK ?? 3;
  const embedded = await input.embedding.embedQuery(input.query);
  const childHits = await input.database.searchChildren(embedded.embedding, Math.max(12, topK * 4));
  return {
    hits: aggregateByParent(childHits, topK),
    embeddingTokens: embedded.tokens,
    durationMs: Math.round(performance.now() - startedAt),
  };
}
