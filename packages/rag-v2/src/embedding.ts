/**
 * Embedding（文本向量化）服务
 *
 * 基于 Vercel AI SDK 的 OpenAI 兼容接口接入 SiliconFlow 嵌入模型：
 * - embedDocuments：分批（每批 32 条）批量向量化，用于知识库摄入
 * - embedQuery：单条向量化，用于检索查询
 * - 统一校验向量维度（默认 1024），避免维度不一致导致入库失败
 */
import { embed, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * 批量向量化结果：向量数组，以及可选的 token 用量（模型未返回时为 undefined）。
 */
export interface EmbeddingBatchResult {
    embeddings: number[][];
    tokens?: number;
}

/**
 * Embedding 服务：封装 SiliconFlow 嵌入模型（OpenAI 兼容接口）。
 */
export class EmbeddingService {
    private readonly model;

    /**
     * @param settings 模型接入参数（API Key / Base URL / 模型名）
     * @param expectedDimensions 期望的向量维度，默认 1024
     */
    constructor(
        settings: { apiKey: string; baseUrl: string; model: string },
        private readonly expectedDimensions = 1024,
    ) {
        const provider = createOpenAICompatible({
            name: "siliconflow",
            apiKey: settings.apiKey,
            baseURL: settings.baseUrl,
        });
        this.model = provider.embeddingModel(settings.model);
    }

    /**
     * 批量向量化文本（每批最多 32 条，逐批串行调用）。
     */
    async embedDocuments(values: string[]): Promise<EmbeddingBatchResult> {
        const embeddings: number[][] = [];
        let tokens = 0;
        let hasUsage = false;
        for (let index = 0; index < values.length; index += 32) {
            const batch = values.slice(index, index + 32);
            const result = await embedMany({ model: this.model, values: batch, maxParallelCalls: 2 });
            this.assertDimensions(result.embeddings);
            embeddings.push(...result.embeddings);
            if (result.usage?.tokens !== undefined) {
                tokens += result.usage.tokens;
                hasUsage = true;
            }
        }
        return { embeddings, tokens: hasUsage ? tokens : undefined };
    }

    /**
     * 单条文本向量化，用于检索查询。
     */
    async embedQuery(value: string): Promise<{ embedding: number[]; tokens?: number }> {
        const result = await embed({ model: this.model, value });
        this.assertDimensions([result.embedding]);
        return { embedding: result.embedding, tokens: result.usage?.tokens };
    }

    /**
     * 校验所有向量的维度符合预期，防止维度不一致导致入库 / 检索异常。
     */
    private assertDimensions(embeddings: number[][]): void {
        const invalid = embeddings.find((value) => value.length !== this.expectedDimensions);
        if (invalid) {
            throw new Error(`Embedding 维度错误：期望 ${this.expectedDimensions}，实际 ${invalid.length}`);
        }
    }
}

/**
 * 拼接用于向量化的文本：有 heading 路径时前缀「路径 > 内容」，否则使用正文。
 */
export function buildEmbeddingText(headingPath: string[], content: string): string {
    return headingPath.length > 0 ? `${headingPath.join(" > ")}\n${content}` : content;
}
