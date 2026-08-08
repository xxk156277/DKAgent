import "dotenv/config";
import { createInterface } from "node:readline";
import { AgentLoop } from "./agent/loop.js";
import { AGENT_SYSTEM_PROMPT } from "./agent/prompt.js";
import { createSafePrompt } from "./cli/safe-prompt.js";
import { loadConfig } from "./config.js";
import { OpenAIProvider } from "./query-engine/providers/openai.js";
import { QueryEngine } from "./query-engine/queryEngine.js";
import { createToolRegistry } from "./tools/index.js";

async function main(): Promise<void> {
    const config = loadConfig();
    const provider = new OpenAIProvider(
        config.apiKey,
        config.baseURL
    );
    // 初始化 - 模型请求中心
    const queryEngine = new QueryEngine(provider);
    // 初始化 - 工具模块
    const toolRegistry = createToolRegistry();
    // 初始化 - AgentLoop
    const agent = new AgentLoop({
        queryEngine,
        toolRegistry,
        model: config.model,
        maxSteps: 4,
        systemPrompt: AGENT_SYSTEM_PROMPT,
        onTextDelta: (text) => process.stdout.write(text),
    });

    const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log("DKAgent 已启动，输入自然语言开始对话，按 Ctrl+C 退出。\n");
    readline.setPrompt("> ");
    const prompt = createSafePrompt(readline);
    prompt();

    // 复用同一个 AgentLoop，让多轮消息保留在当前进程中。
    for await (const input of readline) {
        const userInput = input.trim();
        if (!userInput) {
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
}

main().catch((error: unknown) => {
    const message = error instanceof Error
        ? error.message
        : String(error);
    console.error(`\nAgent 运行失败：${message}`);
    process.exitCode = 1;
});
