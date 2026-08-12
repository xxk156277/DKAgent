import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const readJson = async (path: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));

test("根包声明 agent 与 web-tap workspaces", async () => {
  const rootPackage = await readJson("package.json");
  assert.deepEqual(rootPackage.workspaces, ["packages/*"]);

  const agent = await readJson("packages/agent/package.json");
  const tap = await readJson("packages/web-tap/package.json");

  assert.equal(agent.name, "@dkagent/agent");
  assert.equal(tap.name, "@dkagent/web-tap");
  assert.equal(tap.dependencies["@dkagent/agent"], "*");
  assert.equal(agent.dependencies?.["@dkagent/web-tap"], undefined);
});

test("业务源码和测试已完全迁入两个 workspace", async () => {
  await assert.rejects(access(new URL("src", root)));
  await assert.rejects(access(new URL("test", root)));
  await access(new URL("packages/agent/src/index.ts", root));
  await access(new URL("packages/web-tap/src/observe.ts", root));
});

test("根测试覆盖布局回归且 web-tap 不隐式依赖 dotenv", async () => {
  const agent = await readJson("packages/agent/package.json");
  const tap = await readJson("packages/web-tap/package.json");
  const observeSource = await readFile(
    new URL("packages/web-tap/src/observe.ts", root),
    "utf8",
  );
  const cliSource = await readFile(
    new URL("packages/agent/src/cli/run.ts", root),
    "utf8",
  );

  assert.match(agent.scripts.test, /monorepo-layout\.test\.ts/);
  assert.deepEqual(tap.dependencies, { "@dkagent/agent": "*" });
  assert.doesNotMatch(observeSource, /dotenv/);
  assert.match(cliSource, /dotenv\/config/);
});
