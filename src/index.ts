import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgent } from "./agent/loop.js";
import { loadConfig } from "./config.js";
import { OpenAIProvider } from "./query-engine/providers/openai.js";
import { QueryEngine } from "./query-engine/queryEngine.js";
import { createToolRegistry } from "./tools/index.js";

async function main(): Promise<void> {
    const inputPath = process.argv[2];
    if (!inputPath) {
        throw new Error("用法：npm run agent -- <面试文字稿路径>");
    }

    const transcriptPath = resolve(process.cwd(), inputPath)
    const transcript = await readFile(
        transcriptPath,
        "utf8"
    );

    const targetContent = {
        path: transcriptPath,
        content: transcript
    }

    const config = loadConfig();

    // 初始化 OpenAIProvider 和 queryEngine
    const provider = new OpenAIProvider(config.apiKey, config.baseURL);
    const queryEngine = new QueryEngine(provider);
    const toolRegistry = createToolRegistry()

    const answer = await runAgent(targetContent, {
        queryEngine,
        toolRegistry: toolRegistry,
        model: config.model,
        maxSteps: 4,
        systemPrompt: `
Role:
你是一个可以调用工具的面试材料分析员

收到面试文字稿后，必须先调用 split_qa_pairs
        `,
        onTextDelta: (text) => process.stdout.write(text),
    });

    console.log("\n\n========== 最终结果 ==========");
    console.log(answer);
}

main().catch((error: unknown) => {
    const message = error instanceof Error
        ? error.message
        : String(error);
    console.error(`\nAgent 运行失败：${message}`);
    process.exitCode = 1;
});
