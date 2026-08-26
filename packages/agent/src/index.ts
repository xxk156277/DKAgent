import "dotenv/config";
import { runAgentCli } from "./cli/run.js";

runAgentCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nAgent 运行失败：${message}`);
    process.exitCode = 1;
});
