import "dotenv/config";
import { Tracer } from "@dkagent/trace";
import { createInterface } from "node:readline";
import { AgentLoop } from "../agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "../agent/prompt.js";
import { loadConfig } from "../config.js";
import {
    Compressor,
    ContextManager,
    ProviderTokenCounter,
} from "../context/index.js";
import { OpenAICompatibleProvider } from "../query-engine/providers/openai-compatible.js";
import { QueryEngine } from "../query-engine/query-engine.js";
import {
    SqliteSessionStore,
    type SessionSnapshot,
} from "../session/index.js";
import { createToolRegistry } from "../tools/index.js";
import { createSafePrompt } from "./safe-prompt.js";

/**
 * 原始命令行 Agent 入口；观测能力仅通过可选端口注入，核心无需依赖 Tap。
 */
export async function runAgentCli(options: {
    tracer?: Tracer;
} = {}): Promise<void> {
    const config = loadConfig();
    const provider = new OpenAICompatibleProvider(config.apiKey, config.baseURL);
    const queryEngine = new QueryEngine(provider);
    const toolRegistry = createToolRegistry();
    // 摘要复用统一 QueryEngine；Compressor 不直接依赖具体 Provider。
    const tracer = options.tracer ?? new Tracer();
    const compressor = new Compressor(queryEngine, tracer);
    const contextManager = new ContextManager(
        new ProviderTokenCounter(provider),
        compressor,
        tracer,
    );
    const sessionStore = new SqliteSessionStore(".dkagent/sessions.db");
    const createAgent = (snapshot: SessionSnapshot): AgentLoop =>
        new AgentLoop({
            queryEngine,
            toolRegistry,
            contextManager,
            model: config.model,
            maxContextTokens: config.maxContextTokens,
            maxOutputTokens: config.maxOutputTokens,
            contextCompaction: config.contextCompaction,
            summaryModel: config.summaryModel,
            maxSteps: 5,
            systemPrompt: AGENT_SYSTEM_PROMPT,
            onTextDelta: (text) => process.stdout.write(text),
            tracer,
            session: {
                snapshot,
                store: sessionStore,
            },
        });

    const restored = sessionStore.loadLatest();
    let currentSession = restored ?? sessionStore.create();
    let agent = createAgent(currentSession);

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    const startupMessage = restored
        ? `DKAgent 已恢复 Session ${currentSession.id}，输入 /new 创建新会话。`
        : `DKAgent 已创建 Session ${currentSession.id}，输入自然语言开始对话。`;
    console.log(`${startupMessage}\n`);
    readline.setPrompt("> ");
    const prompt = createSafePrompt(readline);
    prompt();

    try {
        for await (const input of readline) {
            const userInput = input.trim();
            if (!userInput) {
                prompt();
                continue;
            }
            if (userInput === "/new") {
                currentSession = sessionStore.create();
                agent = createAgent(currentSession);
                console.log(`已创建 Session ${currentSession.id}\n`);
                prompt();
                continue;
            }
            try {
                await agent.run(userInput);
                process.stdout.write("\n\n");
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`\nAgent 运行失败：${message}\n`);
            }
            prompt();
        }
    } finally {
        sessionStore.close();
    }
}
