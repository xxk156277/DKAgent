import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { buildEvidenceContext } from "./context.js";
import { EmbeddingService } from "../embedding/embedding.js";
import { searchKnowledge } from "../retrieval/search.js";
import { RagDatabase } from "../storage/database.js";

/**
 * 校验答案中的引用：至少有一个 [n]，且所有 n 都在有效来源范围内。
 */
export function hasValidCitations(answer: string, sourceCount: number): boolean {
    const references = [...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
    return references.length > 0 && references.every((value) => value >= 1 && value <= sourceCount);
}

/**
 * 基于知识库的问答主流程：
 * 检索 -> 相似度阈值 / 多模态拒答判断 -> 拼装证据上下文 -> LLM 生成带引用答案 -> 引用校验。
 */
export async function askKnowledgeBase(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    query: string;
    generation: { apiKey: string; baseUrl: string; model: string };
    minSimilarity?: number;
}): Promise<{
    answer: string;
    hits: Awaited<ReturnType<typeof searchKnowledge>>["hits"];
    durationMs: number;
    usage: { embeddingTokens?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number };
}> {
    const startedAt = performance.now();
    const search = await searchKnowledge({
        database: input.database,
        embedding: input.embedding,
        query: input.query,
        topK: 3,
    });
    const topScore = search.hits[0]?.similarity;
    if (topScore === undefined || (input.minSimilarity !== undefined && topScore < input.minSimilarity)) {
        return {
            answer: "知识库中没有足够证据回答这个问题。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: { embeddingTokens: search.embeddingTokens },
        };
    }
    if (search.hits.every((hit) => hit.needsVision)) {
        return {
            answer: "相关说明主要依赖图片，当前文字版知识库无法可靠回答。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: { embeddingTokens: search.embeddingTokens },
        };
    }

    const context = await buildEvidenceContext(input.database, search.hits, 6000);
    const provider = createOpenAICompatible({
        name: "deepseek",
        apiKey: input.generation.apiKey,
        baseURL: input.generation.baseUrl,
    });
    const result = await generateText({
        model: provider(input.generation.model),
        temperature: 0.1,
        system: [
            "你是严格基于知识库证据回答的助手。",
            "只能使用给定资料，不得补充资料之外的事实。",
            "每个关键结论后必须使用 [1]、[2] 形式标注来源。",
            "如果资料不足、冲突或主要依赖未解析图片，明确拒答并说明缺什么。",
        ].join("\n"),
        prompt: `问题：${input.query}\n\n资料：\n${context}`,
    });
    const answer = hasValidCitations(result.text, search.hits.length)
        ? result.text
        : "模型未能生成可验证引用，因此拒绝返回不可靠答案。";
    return {
        answer,
        hits: search.hits,
        durationMs: Math.round(performance.now() - startedAt),
        usage: {
            embeddingTokens: search.embeddingTokens,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
        },
    };
}
