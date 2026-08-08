export interface AgentConfig {
    apiKey: string;
    model: string;
    baseURL?: string;
}

export function loadConfig(
    env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
    const apiKey = env.LLM_API_KEY?.trim();
    if (!apiKey) throw new Error("缺少环境变量 LLM_API_KEY");

    const baseURL = env.LLM_BASE_URL?.trim();
    return {
        apiKey,
        model: env.LLM_MODEL_ID?.trim() || "gpt-4.1-mini",
        ...(baseURL ? { baseURL } : {}),
    };
}
