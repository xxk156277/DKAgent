/** Embedding 模块只定义向量生成能力，不关心数据库如何保存。 */
export interface EmbeddingProvider {
    /** 当前 Provider 使用的模型标识，用于隔离不同模型的向量。 */
    readonly model: string;
    /** 按输入顺序批量生成向量。 */
    embedBatch(texts: string[]): Promise<number[][]>;
}

/** OpenAI 兼容 Embedding Provider 的构造参数。 */
export interface OpenAICompatibleEmbeddingOptions {
    /** 调用服务所需的 API Key。 */
    apiKey: string;
    /** OpenAI 兼容服务的 API 根地址，例如 https://host/v1。 */
    baseUrl: string;
    /** Embedding 模型标识。 */
    model: string;
    /** 可注入的 fetch，自动化测试用它隔离真实网络。 */
    fetch?: typeof fetch;
}

interface EmbeddingResponseItem {
    index: number;
    embedding: unknown;
}

interface EmbeddingResponse {
    data?: unknown;
}

/**
 * 通过 OpenAI 兼容的 `/embeddings` HTTP 接口批量生成向量。
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    public readonly model: string;
    private readonly apiKey: string;
    private readonly endpoint: string;
    private readonly fetchImplementation: typeof fetch;

    public constructor(options: OpenAICompatibleEmbeddingOptions) {
        if (!options.apiKey.trim() || !options.baseUrl.trim() || !options.model.trim()) {
            throw new Error("Embedding Provider 的 apiKey、baseUrl 和 model 不能为空");
        }

        this.apiKey = options.apiKey;
        this.model = options.model;
        this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/embeddings`;
        this.fetchImplementation = options.fetch ?? globalThis.fetch;
    }

    /** 批量请求向量，并严格校验返回顺序与维度。 */
    public async embedBatch(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        const response = await this.fetchImplementation(this.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: texts }),
        });

        if (!response.ok) {
            const responseText = await response.text();
            throw new Error(`Embedding API 请求失败（${response.status}）：${responseText}`);
        }

        const body = (await response.json()) as EmbeddingResponse;
        if (!Array.isArray(body.data)) {
            throw new Error("Embedding API 返回的 data 不是数组");
        }

        const items = body.data as EmbeddingResponseItem[];
        if (items.length !== texts.length) {
            throw new Error(`Embedding 返回数量不一致：期望 ${texts.length}，实际 ${items.length}`);
        }

        const sortedItems = [...items].sort((left, right) => left.index - right.index);
        const vectors = sortedItems.map((item, expectedIndex) => {
            if (item.index !== expectedIndex || !Array.isArray(item.embedding)) {
                throw new Error("Embedding 返回的 index 或向量格式无效");
            }
            if (
                item.embedding.length === 0 ||
                item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
            ) {
                throw new Error("Embedding 向量必须由有限数字组成");
            }
            return item.embedding as number[];
        });

        const dimensions = vectors[0]?.length;
        if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) {
            throw new Error("Embedding 返回的向量维度不一致");
        }

        return vectors;
    }
}

/**
 * 从环境变量创建真实 Provider；错误信息只包含变量名，不输出变量值。
 */
export function createEmbeddingProviderFromEnv(
    environment: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleEmbeddingProvider {
    const requiredNames = ["EMBEDDING_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL_ID"] as const;
    const missingNames = requiredNames.filter((name) => !environment[name]?.trim());
    if (missingNames.length > 0) {
        throw new Error(`缺少 Embedding 配置：${missingNames.join(", ")}`);
    }

    return new OpenAICompatibleEmbeddingProvider({
        apiKey: environment.EMBEDDING_API_KEY!,
        baseUrl: environment.EMBEDDING_BASE_URL!,
        model: environment.EMBEDDING_MODEL_ID!,
    });
}
