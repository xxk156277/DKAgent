import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

test("Tap 启动失败时仍以无 sink 模式启动 Agent CLI", async (t) => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(4319, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))));

  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "packages/web-tap/src/observe.ts",
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      // 阻止 dotenv 读取本地 .env；测试只使用本测试提供的虚拟配置。
      DOTENV_CONFIG_PATH: "/dev/null",
      LLM_API_KEY: "dummy-not-used",
      LLM_CONTEXT_WINDOW_TOKENS: "100",
      LLM_MAX_OUTPUT_TOKENS: "10",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("observe 降级启动超时"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, text });
    });
  });

  assert.equal(output.code, 0);
  assert.match(output.text, /DKAgent Tap 启动失败，将继续运行 Agent/);
  assert.match(output.text, /DKAgent 已启动/);
});
