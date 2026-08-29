import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const readJson = async (path: string): Promise<Record<string, any>> =>
    JSON.parse(await readFile(new URL(path, root), "utf8"));

test("根包声明 pnpm workspaces", async () => {
    const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
    assert.match(workspace, /packages:\s*\n\s*-\s*["']packages\/\*["']/);

    const agent = await readJson("packages/agent/package.json");
    const trace = await readJson("packages/trace/package.json");
    const tap = await readJson("packages/web-tap/package.json");

    assert.equal(agent.name, "@dkagent/agent");
    assert.equal(trace.name, "@dkagent/trace");
    assert.equal(tap.name, "@dkagent/web-tap");
    assert.equal(tap.dependencies["@dkagent/agent"], "workspace:*");
    assert.equal(tap.dependencies["@dkagent/trace"], "workspace:*");
    assert.equal(agent.dependencies["@dkagent/trace"], "workspace:*");
});

test("业务源码和测试位于独立 workspace", async () => {
    await assert.rejects(access(new URL("src", root)));
    await assert.rejects(access(new URL("test", root)));
    await access(new URL("packages/agent/src/index.ts", root));
    await access(new URL("packages/trace/src/index.ts", root));
    await access(new URL("packages/web-tap/src/observe.ts", root));
});

test("根测试覆盖布局回归且 web-tap 不隐式依赖 dotenv", async () => {
    const agent = await readJson("packages/agent/package.json");
    const tap = await readJson("packages/web-tap/package.json");
    const observeSource = await readFile(new URL("packages/web-tap/src/observe.ts", root), "utf8");
    const cliSource = await readFile(new URL("packages/agent/src/cli/run.ts", root), "utf8");

    assert.match(agent.scripts.test, /monorepo-layout\.test\.ts/);
    // Tap 可以拥有自己的前端依赖，但不能通过 dotenv 隐式读取 Agent 配置。
    assert.equal(tap.dependencies?.dotenv, undefined);
    assert.doesNotMatch(observeSource, /dotenv/);
    assert.match(cliSource, /dotenv\/config/);
});
