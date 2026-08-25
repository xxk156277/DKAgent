import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const observePath = resolve("packages/web-tap/src/observe.ts");
const tsxImportPath = resolve("node_modules/tsx/dist/loader.mjs");

const dummyEnv = {
  PATH: process.env.PATH,
  // 阻止 dotenv 读取本地 .env；测试只使用本测试提供的虚拟配置。
  DOTENV_CONFIG_PATH: "/dev/null",
  LLM_API_KEY: "dummy-not-used",
  LLM_MODEL_ID: "dummy-not-used",
  LLM_CONTEXT_WINDOW_TOKENS: "32000",
  LLM_MAX_OUTPUT_TOKENS: "4096",
};

test("从任意工作目录启动时仍托管包内 Vite 构建", async (t) => {
  const unrelatedCwd = await mkdtemp(join(tmpdir(), "dkagent-observe-cwd-"));
  const modelServer = createModelServer();
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve()))));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  const child = spawn(process.execPath, ["--import", tsxImportPath, observePath], {
    cwd: unrelatedCwd,
    env: { ...dummyEnv, LLM_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1` },
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

  child.stdin.write("observe trace\n");
  await waitForOutput(child, /observe-answer/);
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
  assertPersistedTrace(join(unrelatedCwd, ".dkagent/sessions.db"));
});

test("Tap 启动失败时 Agent 仍使用同一个 SQLite Tracer", async (t) => {
  const isolatedCwd = await mkdtemp(join(tmpdir(), "dkagent-observe-fallback-"));
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(4319, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve()))));
  const modelServer = createModelServer();
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => modelServer.close((error) => (error ? reject(error) : resolve()))));
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");

  const child = spawn(process.execPath, ["--import", tsxImportPath, observePath], {
    cwd: isolatedCwd,
    env: { ...dummyEnv, LLM_BASE_URL: `http://127.0.0.1:${modelAddress.port}/v1` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await waitForOutput(
    child,
    /DKAgent Tap 启动失败，将继续运行 Agent[\s\S]*DKAgent 已创建 Session [0-9a-f-]{36}/,
  );
  child.stdin.write("fallback trace\n");
  await waitForOutput(child, /observe-answer/);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(code, 0);
  assertPersistedTrace(join(isolatedCwd, ".dkagent/sessions.db"));
});

function createModelServer() {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { response_format?: unknown };
      const content = payload.response_format ? '{"memories":[]}' : "observe-answer";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
}

function waitForOutput(child: ReturnType<typeof spawn>, pattern: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 observe 输出超时：${pattern}\n${text}`));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (pattern.test(text)) {
        cleanup();
        resolve(text);
      }
    };
    const onClose = (code: number | null) => {
      cleanup();
      reject(new Error(`observe 提前退出 (${String(code)})：${text}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("close", onClose);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", onClose);
  });
}

function assertPersistedTrace(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    const traces = database.prepare("SELECT status FROM traces").all() as Array<{ status: string }>;
    const spans = database.prepare("SELECT name, status FROM trace_spans").all() as Array<{ name: string; status: string }>;
    assert.equal(traces.length, 1);
    assert.deepEqual(traces.map((trace) => trace.status), ["ok"]);
    assert.ok(spans.some((span) => span.name === "model.generate"));
    assert.ok(spans.every((span) => span.status !== "running"));
  } finally {
    database.close();
  }
}
