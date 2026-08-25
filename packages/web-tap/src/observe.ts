import { fileURLToPath } from "node:url";
import { runAgentCli } from "@dkagent/agent/cli";
import { SqliteSessionStore } from "@dkagent/agent/session";
import { SqliteTraceStore, Tracer } from "@dkagent/trace";
import { createTapSessionReader } from "./tap/session-reader.js";
import { startTapServer } from "./tap/server.js";
import type { TapServerHandle } from "./tap/server.js";

async function main(): Promise<void> {
  const webRoot = fileURLToPath(new URL("../dist/", import.meta.url));
  const sessionStore = new SqliteSessionStore(".dkagent/sessions.db");
  const store = new SqliteTraceStore(".dkagent/sessions.db");
  const tracer = new Tracer(store, {
    onWriteError: () => console.warn("DKAgent Trace 写入失败，本轮业务继续运行。"),
  });
  const sessions = createTapSessionReader(sessionStore, store);
  let server: TapServerHandle;

  try {
    server = await startTapServer({ store, sessions, webRoot });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Viewer 失败不影响主 Agent 与 SQLite Trace。
    console.warn(`DKAgent Tap 启动失败，将继续运行 Agent：${message}`);
    try {
      await runAgentCli({ tracer, sessionStore });
    } finally {
      closeTraceStore(store);
      sessionStore.close();
    }
    return;
  }

  console.log(`DKAgent Tap：${server.url}`);
  try {
    await runAgentCli({ tracer, sessionStore });
  } finally {
    await server.close();
    closeTraceStore(store);
    sessionStore.close();
  }
}

function closeTraceStore(store: SqliteTraceStore): void {
  try {
    store.close();
  } catch {
    console.warn("DKAgent Trace 关闭失败，Session 与业务结果不受影响。");
  }
}

await main();
