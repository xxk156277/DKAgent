import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../../..");
const tsxLoaderPath = join(repositoryRoot, "node_modules/tsx/dist/loader.mjs");
const cliModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/cli/run.ts"),
).href;

function cliScript() {
    return `
        import { runAgentCli } from ${JSON.stringify(cliModuleUrl)};
        runAgentCli().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
}

function runCli(workingDirectory, input) {
    return spawnSync(process.execPath, [
        "--import",
        tsxLoaderPath,
        "--input-type=module",
        "-e",
        cliScript(),
    ], {
        cwd: workingDirectory,
        input,
        encoding: "utf8",
        timeout: 10_000,
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
        },
    });
}

function assertCliSucceeded(result) {
    assert.equal(result.status, 0, result.stderr);
}

function startCli(workingDirectory) {
    const child = spawn(process.execPath, [
        "--import",
        tsxLoaderPath,
        "--input-type=module",
        "-e",
        cliScript(),
    ], {
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

    return {
        child,
        output: () => stdout,
        errorOutput: () => stderr,
        waitForOutput,
        waitForExit: () => new Promise((resolve) => child.once("exit", resolve)),
    };
}

test("/remember 保存、跨进程列出，并按 type/key 覆盖且保留 ID", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-memory-"));
    const created = runCli(
        workingDirectory,
        "/remember preference answer_style 先讲架构\n/memories\n",
    );
    assertCliSucceeded(created);
    const firstId = created.stdout.match(/已保存 Memory ([0-9a-f-]{36})/)?.[1];
    assert.ok(firstId, created.stdout);
    assert.match(
        created.stdout,
        new RegExp(`\\[preference\\] answer_style = 先讲架构 \\(explicit, ${firstId}\\)`),
    );

    const restored = runCli(workingDirectory, "/memories\n");
    assertCliSucceeded(restored);
    assert.match(
        restored.stdout,
        new RegExp(`\\[preference\\] answer_style = 先讲架构 \\(explicit, ${firstId}\\)`),
    );

    const updated = runCli(
        workingDirectory,
        "/remember preference answer_style 先给结论\n/memories\n",
    );
    assertCliSucceeded(updated);
    assert.match(updated.stdout, new RegExp(`已保存 Memory ${firstId}`));
    assert.match(
        updated.stdout,
        new RegExp(`\\[preference\\] answer_style = 先给结论 \\(explicit, ${firstId}\\)`),
    );
});

test("/forget 删除 Memory，重复删除明确提示不存在", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-memory-"));
    const saved = runCli(
        workingDirectory,
        "/remember profile target_role 前端 Agent 工程师\n",
    );
    assertCliSucceeded(saved);
    const memoryId = saved.stdout.match(/已保存 Memory ([0-9a-f-]{36})/)?.[1];
    assert.ok(memoryId, saved.stdout);

    const removed = runCli(
        workingDirectory,
        `/forget ${memoryId}\n/forget ${memoryId}\n/memories\n`,
    );
    assertCliSucceeded(removed);
    assert.match(removed.stdout, new RegExp(`已删除 Memory ${memoryId}`));
    assert.match(removed.stdout, new RegExp(`Memory ${memoryId} 不存在`));
    assert.match(removed.stdout, /暂无 Memory/);
});

test("Memory 参数校验显示中文错误且 CLI 保持运行", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-memory-"));
    const result = runCli(
        workingDirectory,
        [
            "/remember",
            "/remember invalid answer_style 内容",
            "/remember preference Answer_Style 内容",
            "/remember profile api_key 保存密钥",
            "/forget",
            "/memories",
        ].join("\n") + "\n",
    );

    assertCliSucceeded(result);
    assert.match(result.stdout, /用法：\/remember/);
    assert.match(result.stdout, /Memory 类别不合法/);
    assert.match(result.stdout, /Memory key/);
    assert.match(result.stdout, /Memory content 不能包含凭据语义/);
    assert.match(result.stdout, /用法：\/forget <memoryId>/);
    assert.match(result.stdout, /暂无 Memory/);
});

test("Memory 数据库初始化失败时 CLI 明确报错", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-memory-"));
    writeFileSync(join(workingDirectory, ".dkagent"), "not a directory");

    const result = runCli(workingDirectory, "");

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Memory 数据库初始化失败/);
});

test("/new、/switch、/delete 只管理 Session，不删除 Memory", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-memory-"));
    const cli = startCli(workingDirectory);

    try {
        const startup = await cli.waitForOutput(
            /DKAgent 已创建 Session ([0-9a-f-]{36})/,
        );
        const firstSessionId = startup[1];

        let outputIndex = cli.output().length;
        cli.child.stdin.write("/remember decision memory_mvp 使用 SQLite\n");
        const saved = await cli.waitForOutput(
            /已保存 Memory ([0-9a-f-]{36})/,
            outputIndex,
        );
        const memoryId = saved[1];

        outputIndex = cli.output().length;
        cli.child.stdin.write("/new\n");
        const created = await cli.waitForOutput(
            /已创建 Session ([0-9a-f-]{36})/,
            outputIndex,
        );
        const secondSessionId = created[1];

        outputIndex = cli.output().length;
        cli.child.stdin.write(`/switch ${firstSessionId}\n`);
        await cli.waitForOutput(
            new RegExp(`已切换到 Session ${firstSessionId}`),
            outputIndex,
        );

        outputIndex = cli.output().length;
        cli.child.stdin.write(`/delete ${secondSessionId}\n`);
        await cli.waitForOutput(
            new RegExp(`已删除 Session ${secondSessionId}`),
            outputIndex,
        );

        outputIndex = cli.output().length;
        cli.child.stdin.write("/memories\n");
        await cli.waitForOutput(
            new RegExp(`\\[decision\\] memory_mvp = 使用 SQLite \\(explicit, ${memoryId}\\)`),
            outputIndex,
        );
    } finally {
        const exited = cli.waitForExit();
        cli.child.stdin.end();
        assert.equal(await exited, 0, cli.errorOutput());
    }
});
