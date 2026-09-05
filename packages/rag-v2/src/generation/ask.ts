import { generateText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { EmbeddingService } from "../embedding/embedding.js";
import { searchKnowledge } from "../retrieval/search.js";
import { RagDatabase } from "../storage/database.js";
import {
    hasValidCitations,
    normalizeCitationVerification,
    verifyCitationSupport,
    type CitationVerification,
} from "./citation.js";
import { buildEvidenceBundle } from "./context.js";

export { hasValidCitations, normalizeCitationVerification } from "./citation.js";

/** 问答最终状态。 */
export type AskStatus = "answered" | "refused";

/** 可诊断的拒答原因。 */
export type RefusalReason =
    | "insufficient_evidence"
    | "vision_required"
    | "model_insufficient_evidence"
    | "invalid_citations"
    | "unsupported_citations"
    | "citation_verification_failed";

/** 分阶段调用量，避免把生成和验证成本混在一起。 */
export interface AskUsage {
    embeddingTokens?: number | undefined;
    generationInputTokens?: number | undefined;
    generationOutputTokens?: number | undefined;
    generationTokens?: number | undefined;
    verificationInputTokens?: number | undefined;
    verificationOutputTokens?: number | undefined;
    verificationTokens?: number | undefined;
}

/** 完整问答结果，包含最终回答、被拒草稿和验证诊断。 */
export interface AskResult {
    status: AskStatus;
    refusalReason?: RefusalReason | undefined;
    answer: string;
    draftAnswer?: string | undefined;
    verification?: CitationVerification | undefined;
    hits: Awaited<ReturnType<typeof searchKnowledge>>["hits"];
    durationMs: number;
    usage: AskUsage;
}

const GeneratedAnswerSchema = z.object({
    canAnswer: z.boolean(),
    answer: z.string(),
});

function embeddingUsage(tokens: number | undefined): AskUsage {
    return tokens === undefined ? {} : { embeddingTokens: tokens };
}

/**
 * 基于知识库的问答主流程：
 * 混合检索 -> 生成前拒答 -> 证据组装 -> LLM 草稿 -> 引用语法与语义验证 -> 回答或降级。
 */
export async function askKnowledgeBase(input: {
    database: RagDatabase;
    embedding: EmbeddingService;
    query: string;
    generation: { apiKey: string; baseUrl: string; model: string };
    minSimilarity?: number | undefined;
    expectedFacts?: string[] | undefined;
}): Promise<AskResult> {
    const startedAt = performance.now();
    // 混合检索
    const search = await searchKnowledge({
        database: input.database,
        embedding: input.embedding,
        query: input.query,
        topK: 3,
        strategy: "hybrid",
    });

    //
    const topScore = search.hits[0]?.similarity;
    if (topScore === undefined || (input.minSimilarity !== undefined && topScore < input.minSimilarity)) {
        return {
            status: "refused",
            refusalReason: "insufficient_evidence",
            answer: "知识库中没有足够证据回答这个问题。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: embeddingUsage(search.embeddingTokens),
        };
    }
    if (search.hits.every((hit) => hit.needsVision)) {
        return {
            status: "refused",
            refusalReason: "vision_required",
            answer: "相关说明主要依赖图片，当前文字版知识库无法可靠回答。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: embeddingUsage(search.embeddingTokens),
        };
    }

    const evidence = await buildEvidenceBundle(input.database, search.hits, 6000);
    if (!evidence.text) {
        return {
            status: "refused",
            refusalReason: "insufficient_evidence",
            answer: "知识库中没有足够证据回答这个问题。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: embeddingUsage(search.embeddingTokens),
        };
    }
    const provider = createOpenAICompatible({
        name: "deepseek",
        apiKey: input.generation.apiKey,
        baseURL: input.generation.baseUrl,
    });

    const generated = await generateText({
        model: provider(input.generation.model),
        temperature: 0.1,
        output: Output.object({ schema: GeneratedAnswerSchema }),
        system: [
            "你是严格基于知识库证据回答的助手。",
            "只能使用给定资料，不得补充资料之外的事实。",
            "每个关键结论后必须使用 [1]、[2] 形式标注来源。",
            "如果资料不足、冲突或主要依赖未解析图片，明确拒答并说明缺什么。",
            "资料足够时 canAnswer=true；资料不足时 canAnswer=false，answer 简要说明缺失证据。",
        ].join("\n"),
        prompt: `问题：${input.query}\n\n资料：\n${evidence.text}`,
    });
    const generationUsage: AskUsage = {
        ...embeddingUsage(search.embeddingTokens),
        generationInputTokens: generated.usage.inputTokens,
        generationOutputTokens: generated.usage.outputTokens,
        generationTokens: generated.usage.totalTokens,
    };
    const draftAnswer = generated.output.answer;

    if (!generated.output.canAnswer) {
        return {
            status: "refused",
            refusalReason: "model_insufficient_evidence",
            answer: draftAnswer || "知识库资料不足，无法可靠回答。",
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: generationUsage,
        };
    }

    if (!hasValidCitations(draftAnswer, search.hits.length)) {
        return {
            status: "refused",
            refusalReason: "invalid_citations",
            answer: "模型未能生成可验证引用，因此拒绝返回不可靠答案。",
            draftAnswer,
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: generationUsage,
        };
    }

    try {
        const verified = await verifyCitationSupport({
            query: input.query,
            answer: draftAnswer,
            evidence,
            expectedFacts: input.expectedFacts,
            generation: input.generation,
        });
        const usage: AskUsage = {
            ...generationUsage,
            verificationInputTokens: verified.usage.inputTokens,
            verificationOutputTokens: verified.usage.outputTokens,
            verificationTokens: verified.usage.totalTokens,
        };
        if (!verified.verification.citationSupported) {
            return {
                status: "refused",
                refusalReason: "unsupported_citations",
                answer: "检索资料无法支持模型草稿中的全部关键结论，因此拒绝返回不可靠答案。",
                draftAnswer,
                verification: verified.verification,
                hits: search.hits,
                durationMs: Math.round(performance.now() - startedAt),
                usage,
            };
        }
        return {
            status: "answered",
            answer: draftAnswer,
            verification: verified.verification,
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage,
        };
    } catch {
        return {
            status: "refused",
            refusalReason: "citation_verification_failed",
            answer: "引用语义验证失败，因此拒绝返回未经验证的答案。",
            draftAnswer,
            hits: search.hits,
            durationMs: Math.round(performance.now() - startedAt),
            usage: generationUsage,
        };
    }
}
