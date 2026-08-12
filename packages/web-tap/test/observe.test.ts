import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const observePath = resolve("packages/web-tap/src/observe.ts");
const tsxImportPath = resolve("node_modules/tsx/dist/loader.mjs");

const dummyEnv = {
  PATH: process.env.PATH,
  // 阻止 dotenv 读取本地 .env；测试只使用本测试提供的虚拟配置。
  DOTENV_CONFIG_PATH: "/dev/null",
  LLM_API_KEY: "dummy-not-used",
  LLM_MODEL_ID: "dummy-not-used",
  LLM_CONTEXT_WINDOW_TOKENS: "100",
  LLM_MAX_OUTPUT_TOKENS: "10",
};

test("从任意工作目录启动时仍托管包内 Vite 构建", async (t) => {
  const unrelatedCwd = await mkdtemp(join(tmpdir(), "dkagent-observe-cwd-"));
  const child = spawn(process.execPath, ["--import", tsxImportPath, observePath], {
    cwd: unrelatedCwd,
    env: dummyEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (!child.killed) child.kill();
  });

  const output = await new Promise<string>((resolveOutput, reject) => {
    let text = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`observe 启动超时：${text}`));
    }, 5_000);
    const onOutput = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("DKAgent Tap：http://127.0.0.1:4319/")) {
        clearTimeout(timeout);
        resolveOutput(text);
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (!text.includes("DKAgent Tap：http://127.0.0.1:4319/")) {
        reject(new Error(`observe 提前退出 (${String(code)})：${text}`));
      }
    });
  });

  assert.doesNotMatch(output, /Tap 启动失败/);
  const response = await fetch("http://127.0.0.1:4319/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<div id="root"><\/div>/);

  child.stdin.end();
  await new Promise<void>((resolveClose, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("observe 退出超时"));
    }, 5_000);
    child.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
});

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
    env: dummyEnv,
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
