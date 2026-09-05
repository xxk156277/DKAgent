import type {
  ApiProvider,
  CallApiContextParams,
  ProviderResponse,
} from "promptfoo";
import { config, requireSecret } from "../../packages/rag-v2/src/config.js";
import { EmbeddingService } from "../../packages/rag-v2/src/embedding/embedding.js";
import { askKnowledgeBase } from "../../packages/rag-v2/src/generation/ask.js";
import { buildEvidenceBundle } from "../../packages/rag-v2/src/generation/context.js";
import { RagDatabase } from "../../packages/rag-v2/src/storage/database.js";

/** Promptfoo 从 Provider 输出中分别提取答案和真实生成上下文。 */
export interface RagPromptfooOutput {
  answer: string;
  context: string;
  status: "answered" | "refused";
  refusalReason?: string | undefined;
  sources: string[];
}

/** 汇总 RAG 各阶段 Token，供 Promptfoo 报告调用量。 */
function sumUsage(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Promptfoo 自定义 Provider：执行真实 Hybrid RAG，并返回答案与证据上下文。 */
export class RagPromptfooProvider implements ApiProvider {
  public readonly label = "DKAgent RAG v2";
  private database: RagDatabase | undefined;
  private embedding: EmbeddingService | undefined;

  public constructor() {
    // Promptfoo 会遍历配置对象，绑定方法可避免实例方法上下文丢失。
    this.id = this.id.bind(this);
    this.callApi = this.callApi.bind(this);
    this.cleanup = this.cleanup.bind(this);
  }

  public id(): string {
    return "dkagent-rag-v2";
  }

  private getRuntime(): { database: RagDatabase; embedding: EmbeddingService } {
    this.database ??= new RagDatabase(config.databaseUrl);
    this.embedding ??= new EmbeddingService(
      {
        apiKey: requireSecret(config.embedding.apiKey, "SILICONFLOW_API_KEY"),
        baseUrl: config.embedding.baseUrl,
        model: config.embedding.model,
      },
      config.embedding.dimensions,
    );
    return { database: this.database, embedding: this.embedding };
  }

  public async callApi(
    prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    try {
      const query = context?.vars?.query;
      if (typeof query !== "string" || query.length === 0 || query !== prompt) {
        throw new Error("Promptfoo 用例缺少有效 query");
      }
      const expectedFacts = context?.vars?.expectedFacts;
      if (!Array.isArray(expectedFacts) || !expectedFacts.every((fact) => typeof fact === "string")) {
        throw new Error("Promptfoo 用例的 expectedFacts 必须是字符串数组");
      }
      const normalizedExpectedFacts = expectedFacts as string[];

      const runtime = this.getRuntime();
      const result = await askKnowledgeBase({
        database: runtime.database,
        embedding: runtime.embedding,
        query,
        generation: {
          apiKey: requireSecret(config.generation.apiKey, "DEEPSEEK_API_KEY"),
          baseUrl: config.generation.baseUrl,
          model: config.generation.model,
        },
        minSimilarity: config.minSimilarity,
        expectedFacts: normalizedExpectedFacts,
      });
      const evidence = await buildEvidenceBundle(runtime.database, result.hits, 6000);
      const output: RagPromptfooOutput = {
        answer: result.answer,
        context: evidence.text,
        status: result.status,
        refusalReason: result.refusalReason,
        sources: evidence.sources.map(
          (source) => `${source.sourcePath}#${source.headingPath.join(" > ") || "全文"}`,
        ),
      };
      const promptTokens = sumUsage([
        result.usage.embeddingTokens,
        result.usage.generationInputTokens,
        result.usage.verificationInputTokens,
      ]);
      const completionTokens = sumUsage([
        result.usage.generationOutputTokens,
        result.usage.verificationOutputTokens,
      ]);

      return {
        output,
        isRefusal: result.status === "refused",
        latencyMs: result.durationMs,
        tokenUsage: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
        metadata: {
          status: result.status,
          refusalReason: result.refusalReason,
          sources: output.sources,
        },
      };
    } catch (error: unknown) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Promptfoo 结束后关闭共享数据库连接池。 */
  public async cleanup(): Promise<void> {
    await this.database?.close();
    this.database = undefined;
    this.embedding = undefined;
  }
}
