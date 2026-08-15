import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../../..");
const tsxPath = join(repositoryRoot, "node_modules/.bin/tsx");
const cliModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/cli/run.ts"),
).href;

function startCli(workingDirectory) {
    const script = `
        import { runAgentCli } from ${JSON.stringify(cliModuleUrl)};
        runAgentCli().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const child = spawn(tsxPath, ["-e", script], {
        cwd: workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
        },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    const waitForOutput = (pattern, fromIndex = 0) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`等待 CLI 输出超时：${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 10_000);
        const check = () => {
            const match = stdout.slice(fromIndex).match(pattern);
            if (!match) return;
            cleanup();
            resolve(match);
        };
        const onExit = (code) => {
            cleanup();
            reject(new Error(`CLI 提前退出：${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        };
        const cleanup = () => {
            clearTimeout(timeout);
            child.stdout.off("data", check);
            child.off("exit", onExit);
        };
        child.stdout.on("data", check);
        child.on("exit", onExit);
        check();
    });

    const waitForExit = () => new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
    });

    return {
        child,
        output: () => stdout,
        errorOutput: () => stderr,
        waitForOutput,
        waitForExit,
    };
}

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

test("CLI 可以列出、切换和删除非当前 Session", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-session-"));
    const cli = startCli(workingDirectory);

    const startup = await cli.waitForOutput(
        /DKAgent 已创建 Session ([0-9a-f-]{36})/,
    );
    const firstSessionId = startup[1];

    let outputIndex = cli.output().length;
    cli.child.stdin.write("/new\n");
    const created = await cli.waitForOutput(
        /已创建 Session ([0-9a-f-]{36})/,
        outputIndex,
    );
    const secondSessionId = created[1];

    outputIndex = cli.output().length;
    cli.child.stdin.write("/switch\n");
    await cli.waitForOutput(/用法：\/switch <sessionId>/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${secondSessionId}\n`);
    await cli.waitForOutput(/已经是当前 Session/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/switch missing-session\n");
    await cli.waitForOutput(/Session missing-session 不存在/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/delete\n");
    await cli.waitForOutput(/用法：\/delete <sessionId>/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/delete missing-session\n");
    await cli.waitForOutput(/Session missing-session 不存在/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write("/sessions\n");
    await cli.waitForOutput(
        new RegExp(`\\* ${secondSessionId}[\\s\\S]*  ${firstSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${firstSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已切换到 Session ${firstSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/delete ${firstSessionId}\n`);
    await cli.waitForOutput(/不能删除当前 Session/, outputIndex);

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/switch ${secondSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已切换到 Session ${secondSessionId}`),
        outputIndex,
    );

    outputIndex = cli.output().length;
    cli.child.stdin.write(`/delete ${firstSessionId}\n`);
    await cli.waitForOutput(
        new RegExp(`已删除 Session ${firstSessionId}`),
        outputIndex,
    );

    const exitPromise = cli.waitForExit();
    cli.child.stdin.end();
    const exitCode = await exitPromise;
    assert.equal(exitCode, 0, cli.errorOutput());
});
