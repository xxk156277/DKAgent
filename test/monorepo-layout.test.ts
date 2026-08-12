import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("根包声明 agent 与 web-tap workspaces", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(root.workspaces, ["packages/*"]);

  const agent = JSON.parse(
    await readFile("packages/agent/package.json", "utf8"),
  );
  const tap = JSON.parse(
    await readFile("packages/web-tap/package.json", "utf8"),
  );

  assert.equal(agent.name, "@dkagent/agent");
  assert.equal(tap.name, "@dkagent/web-tap");
  assert.equal(tap.dependencies["@dkagent/agent"], "*");
  assert.equal(agent.dependencies?.["@dkagent/web-tap"], undefined);
});
