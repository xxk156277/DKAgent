import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../../..");
const tsxPath = join(repositoryRoot, "node_modules/.bin/tsx");
const cliModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/cli/run.ts"),
).href;

test("CLI 启动时创建 Session，输入 /new 后切换到新 Session", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-session-"));
    const script = `
        import { runAgentCli } from ${JSON.stringify(cliModuleUrl)};
        runAgentCli().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const result = spawnSync(tsxPath, ["-e", script], {
        cwd: workingDirectory,
        input: "/new\n",
        encoding: "utf8",
        timeout: 10_000,
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
        },
    });

    assert.equal(result.status, 0, result.stderr);
    const sessionIds = [
        ...result.stdout.matchAll(/Session ([0-9a-f-]{36})/g),
    ].map((match) => match[1]);
    assert.equal(sessionIds.length, 2, result.stdout);
    assert.notEqual(sessionIds[0], sessionIds[1]);
    assert.equal(
        existsSync(join(workingDirectory, ".dkagent/sessions.db")),
        true,
    );
});
