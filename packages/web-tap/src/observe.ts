import { fileURLToPath } from "node:url";
import { runAgentCli } from "@dkagent/agent/cli";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { startTapServer } from "./tap/server.js";
import type { TapServerHandle } from "./tap/server.js";

async function main(): Promise<void> {
  const webRoot = fileURLToPath(new URL("../dist/", import.meta.url));
  const store = new MemoryTraceStore();
  const tracer = new Tracer(store);
  let server: TapServerHandle;

  try {
    server = await startTapServer({ store, webRoot });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Viewer 失败仅关闭其订阅；主 Agent 继续以无观测 sink 运行。
    console.warn(`DKAgent Tap 启动失败，将继续运行 Agent：${message}`);
    await runAgentCli();
    return;
  }

  console.log(`DKAgent Tap：${server.url}`);
  try {
    await runAgentCli({ tracer });
  } finally {
    await server.close();
  }
}

await main();
