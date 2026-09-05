import type { SearchHit } from "../domain/types.js";
import { RagDatabase, type StoredDocument } from "../storage/database.js";

/** 提供给生成与引用验证的单条编号证据。 */
export interface EvidenceSource {
    index: number;
    sourcePath: string;
    headingPath: string[];
    content: string;
}

/** 结构化证据及其给模型使用的文本表示。 */
export interface EvidenceBundle {
    text: string;
    sources: EvidenceSource[];
}

/**
 * 从父文档中选择与命中子块相关的上下文片段：
 * 文档不长时直接返回全文，否则取命中块及其前后邻居，并裁剪到 maxChars。
 */
export function selectParentContext(document: StoredDocument, chunkId: string, maxChars: number): string {
    if (maxChars <= 0) return "";
    if (document.parent.content.length <= maxChars) return document.parent.content;
    const hitIndex = document.chunks.findIndex((chunk) => chunk.id === chunkId);
    if (hitIndex < 0) return "";
    const hit = document.chunks[hitIndex]!.content.slice(0, maxChars);
    let remaining = maxChars - hit.length;
    if (remaining <= 0) return hit;

    const previous = document.chunks[hitIndex - 1]?.content;
    const next = document.chunks[hitIndex + 1]?.content;
    const neighborCount = Number(previous !== undefined) + Number(next !== undefined);
    // 为邻居分隔符预留空间，避免拼接后再次裁掉已经保证完整的命中块。
    remaining = Math.max(0, remaining - neighborCount * 2);
    const previousBudget = previous === undefined ? 0 : Math.floor(remaining / neighborCount);
    const previousPart = previous !== undefined && previousBudget > 0 ? previous.slice(-previousBudget) : "";
    remaining -= previousPart.length;
    const nextPart = next !== undefined && remaining > 0 ? next.slice(0, remaining) : "";

    return joinWithoutBoundaryOverlap([previousPart, hit, nextPart]);
}

/** 删除相邻切片之间完全相同的后缀 / 前缀，避免 overlap 重复进入 LLM 上下文。 */
export function joinWithoutBoundaryOverlap(parts: string[]): string {
    const nonEmpty = parts.filter(Boolean);
    if (nonEmpty.length === 0) return "";
    let result = nonEmpty[0]!;
    for (const part of nonEmpty.slice(1)) {
        let overlapLength = Math.min(result.length, part.length);
        while (overlapLength > 0 && !result.endsWith(part.slice(0, overlapLength))) overlapLength -= 1;
        result += `${overlapLength > 0 ? "" : "\n\n"}${part.slice(overlapLength)}`;
    }
    return result;
}

/**
 * 构建给 LLM 的证据上下文：为每个命中来源拼出带 [n] 编号的标题与正文片段，
 * 并按总预算（默认 6000 字符）均分裁剪。
 */
export async function buildEvidenceBundle(
    database: RagDatabase,
    hits: SearchHit[],
    maxChars = 6000,
): Promise<EvidenceBundle> {
    const sources: EvidenceSource[] = [];
    const perSourceBudget = Math.floor(maxChars / Math.max(1, hits.length));
    const documents = await Promise.all(hits.map((hit) => database.getDocument(hit.parentId)));
    for (let index = 0; index < hits.length; index += 1) {
        const hit = hits[index]!;
        const document = documents[index];
        if (!document) continue;
        const header = `[${index + 1}] ${hit.sourcePath}#${hit.headingPath.join(" > ") || "全文"}\n`;
        const body = selectParentContext(document, hit.chunkId, Math.max(0, perSourceBudget - header.length));
        if (!body) continue;
        sources.push({
            index: index + 1,
            sourcePath: hit.sourcePath,
            headingPath: hit.headingPath,
            content: body.slice(0, Math.max(0, perSourceBudget - header.length)),
        });
    }
    return {
        text: sources
            .map(
                (source) =>
                    `[${source.index}] ${source.sourcePath}#${source.headingPath.join(" > ") || "全文"}\n${source.content}`,
            )
            .join("\n\n")
            .slice(0, maxChars),
        sources,
    };
}

/** 兼容只需要文本的调用方。 */
export async function buildEvidenceContext(database: RagDatabase, hits: SearchHit[], maxChars = 6000): Promise<string> {
    return (await buildEvidenceBundle(database, hits, maxChars)).text;
}
