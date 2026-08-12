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
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
    const apiKey = env.LLM_API_KEY?.trim();

    if (!apiKey) {
        throw new Error(
            "缺少环境变量 LLM_API_KEY",
        );
    }

    /** ------ 从env中获取基本配置信息 -------- */
    const baseURL = env.LLM_BASE_URL?.trim();

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

    return {
        apiKey,
        model: env.LLM_MODEL_ID?.trim() || "gpt-4.1-mini",
        maxContextTokens,
        maxOutputTokens,
        ...(baseURL ? { baseURL } : {}),
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
