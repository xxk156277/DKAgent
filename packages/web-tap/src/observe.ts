import { join } from "node:path";
import { runAgentCli } from "@dkagent/agent/cli";
import { TapRecorder } from "./tap/recorder.js";
import { startTapServer } from "./tap/server.js";
import type { TapServerHandle } from "./tap/server.js";

async function main(): Promise<void> {
  const tracePath = join(process.cwd(), ".traces", "events.jsonl");
  const recorder = new TapRecorder(tracePath);
  let server: TapServerHandle;

  try {
    server = await startTapServer({ recorder });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Viewer 失败仅关闭其订阅；主 Agent 继续以无观测 sink 运行。
    console.warn(`DKAgent Tap 启动失败，将继续运行 Agent：${message}`);
    await runAgentCli();
    return;
  }

  console.log(`DKAgent Tap：${server.url}`);
  try {
    await runAgentCli({ runtimeEventSink: recorder });
  } finally {
    await recorder.flush();
    await server.close();
  }
}

await main();
