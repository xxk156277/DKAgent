import { embed, embedMany } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export interface EmbeddingBatchResult {
  embeddings: number[][];
  tokens?: number;
}

export class EmbeddingService {
  private readonly model;

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

  async embedQuery(value: string): Promise<{ embedding: number[]; tokens?: number }> {
    const result = await embed({ model: this.model, value });
    this.assertDimensions([result.embedding]);
    return { embedding: result.embedding, tokens: result.usage?.tokens };
  }

  private assertDimensions(embeddings: number[][]): void {
    const invalid = embeddings.find((value) => value.length !== this.expectedDimensions);
    if (invalid) {
      throw new Error(`Embedding 维度错误：期望 ${this.expectedDimensions}，实际 ${invalid.length}`);
    }
  }
}

export function buildEmbeddingText(headingPath: string[], content: string): string {
  return headingPath.length > 0 ? `${headingPath.join(" > ")}\n${content}` : content;
}
