import type { StoredDocument } from "./database.js";
import type { SearchHit } from "./types.js";
import { RagDatabase } from "./database.js";

export function selectParentContext(document: StoredDocument, chunkId: string, maxChars: number): string {
  if (document.parent.content.length <= maxChars) return document.parent.content;
  const hitIndex = document.chunks.findIndex((chunk) => chunk.id === chunkId);
  if (hitIndex < 0) return "";
  const selected = document.chunks.slice(Math.max(0, hitIndex - 1), hitIndex + 2);
  return selected.map((chunk) => chunk.content).join("\n\n").slice(0, maxChars);
}

export async function buildEvidenceContext(
  database: RagDatabase,
  hits: SearchHit[],
  maxChars = 6000,
): Promise<string> {
  const blocks: string[] = [];
  const perSourceBudget = Math.floor(maxChars / Math.max(1, hits.length));
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]!;
    const document = await database.getDocument(hit.parentId);
    if (!document) continue;
    const header = `[${index + 1}] ${hit.sourcePath}#${hit.headingPath.join(" > ") || "全文"}\n`;
    const body = selectParentContext(document, hit.chunkId, Math.max(0, perSourceBudget - header.length));
    if (!body) continue;
    const block = `${header}${body}`.slice(0, perSourceBudget);
    blocks.push(block);
  }
  return blocks.join("\n\n");
}
