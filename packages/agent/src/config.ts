import type { ContextCompactionOptions } from "./context/types.js";

/**
 * Context V2 首版统一压缩策略。
 * 模型容量属于部署配置；这些比例和局部上限属于 Agent 的上下文策略。
 */
export const DEFAULT_CONTEXT_COMPACTION_OPTIONS: ContextCompactionOptions = {
    enabled: true,
    triggerRatio: 0.8,
    targetRatio: 0.6,
    maxSummaryTokens: 1_000,
    maxToolResultChars: 2_000,
};

export interface AgentConfig {
    /** 调用模型服务的 API Key。 */
    apiKey: string;
    /** 当前使用的模型 ID。 */
    model: string;
    /** 可选的 OpenAI 兼容服务地址。 */
    baseURL?: string;
    /** 模型允许的最大上下文 Token 数。 */
    maxContextTokens: number;
    /** 单轮模型允许输出的最大 Token 数。 */
    maxOutputTokens: number;
    /** 历史摘要与内容压缩使用的统一策略。 */
    contextCompaction: ContextCompactionOptions;
    /** 历史摘要使用的模型 ID；首版默认复用主模型。 */
    summaryModel: string;
    knowledgeDatabasePath?: string;
}

type ProviderName = "qwen" | "deepseek";

interface ProviderProfile {
    apiKeyVariable: string;
    modelVariable: string;
    baseUrlVariable: string;
    defaultModel: string;
    defaultBaseUrl: string;
}

const DEFAULT_PROVIDER: ProviderName = "qwen";

const PROVIDER_PROFILES: Record<ProviderName, ProviderProfile> = {
    qwen: {
        apiKeyVariable: "QWEN_API_KEY",
        modelVariable: "QWEN_MODEL_ID",
        baseUrlVariable: "QWEN_BASE_URL",
        defaultModel: "qwen3.7-flash",
        defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    deepseek: {
        apiKeyVariable: "DEEPSEEK_API_KEY",
        modelVariable: "DEEPSEEK_MODEL_ID",
        baseUrlVariable: "DEEPSEEK_BASE_URL",
        defaultModel: "deepseek-v4-pro",
        defaultBaseUrl: "https://api.deepseek.com",
    },
};

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
    const providerConfig = loadProviderConfig(env);

    const maxContextTokens = parsePositiveInteger(
        env.LLM_CONTEXT_WINDOW_TOKENS,
        32_000,
        "LLM_CONTEXT_WINDOW_TOKENS",
    );

    const maxOutputTokens = parsePositiveInteger(
        env.LLM_MAX_OUTPUT_TOKENS,
        4_096,
        "LLM_MAX_OUTPUT_TOKENS",
    );

    if (maxOutputTokens >= maxContextTokens) {
        throw new Error(
            [
                "LLM_MAX_OUTPUT_TOKENS",
                "必须小于",
                "LLM_CONTEXT_WINDOW_TOKENS",
            ].join(" "),
        );
    }

    const knowledgeDatabasePath = env.KNOWLEDGE_DATABASE_PATH?.trim();

    return {
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        maxContextTokens,
        maxOutputTokens,
        contextCompaction: {
            ...DEFAULT_CONTEXT_COMPACTION_OPTIONS,
        },
        summaryModel:
            env.LLM_SUMMARY_MODEL_ID?.trim() || providerConfig.model,
        ...(providerConfig.baseURL
            ? { baseURL: providerConfig.baseURL }
            : {}),
        ...(knowledgeDatabasePath ? { knowledgeDatabasePath } : {}),
    };
}

/**
 * 解析模型配置档；旧版 LLM_* 变量保持兼容，便于已有部署平滑迁移。
 */
function loadProviderConfig(env: NodeJS.ProcessEnv): {
    apiKey: string;
    model: string;
    baseURL?: string;
} {
    const configuredProvider = env.LLM_PROVIDER?.trim().toLowerCase();

    if (!configuredProvider && env.LLM_API_KEY?.trim()) {
        const baseURL = env.LLM_BASE_URL?.trim();
        return {
            apiKey: env.LLM_API_KEY.trim(),
            model: env.LLM_MODEL_ID?.trim() || "gpt-4.1-mini",
            ...(baseURL ? { baseURL } : {}),
        };
    }

    const provider = configuredProvider || DEFAULT_PROVIDER;
    if (provider !== "qwen" && provider !== "deepseek") {
        throw new Error("LLM_PROVIDER 必须是 qwen 或 deepseek");
    }

    const profile = PROVIDER_PROFILES[provider];
    const profileApiKey = env[profile.apiKeyVariable]?.trim();
    const legacyApiKey = provider === "deepseek"
        ? env.LLM_API_KEY?.trim()
        : undefined;
    const apiKey = profileApiKey || legacyApiKey;
    if (!apiKey) {
        throw new Error(`缺少环境变量 ${profile.apiKeyVariable}`);
    }

    const usesLegacyDeepSeekProfile = provider === "deepseek" && !profileApiKey;
    const legacyModel = usesLegacyDeepSeekProfile
        ? env.LLM_MODEL_ID?.trim()
        : undefined;
    const legacyBaseUrl = usesLegacyDeepSeekProfile
        ? env.LLM_BASE_URL?.trim()
        : undefined;

    return {
        apiKey,
        model:
            env[profile.modelVariable]?.trim()
            || legacyModel
            || profile.defaultModel,
        baseURL:
            env[profile.baseUrlVariable]?.trim()
            || legacyBaseUrl
            || profile.defaultBaseUrl,
    };
}

/**
 * 读取正整数环境变量。
 *
 * 未配置时使用默认值，配置错误时明确失败。
 */
function parsePositiveInteger(
    value: string | undefined,
    defaultValue: number,
    variableName: string,
): number {
    if (!value?.trim()) {
        return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
            `${variableName} 必须是正整数`,
        );
    }
    return parsed;
}
