import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import test from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../../..");
const tsxPath = join(repositoryRoot, "node_modules/.bin/tsx");
const cliModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/cli/run.ts"),
).href;
const toolRegistryModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/tools/registry.ts"),
).href;
const sessionModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/agent/src/session/index.ts"),
).href;
const traceModuleUrl = pathToFileURL(
    join(repositoryRoot, "packages/trace/src/index.ts"),
).href;

function startCli(workingDirectory, {
    runAgentOptions = "",
    scriptPreamble = "",
    environment = {},
} = {}) {
    const script = `
        import { appendFileSync } from "node:fs";
        ${scriptPreamble}
        const { runAgentCli } = await import(${JSON.stringify(cliModuleUrl)});
        runAgentCli(${runAgentOptions}).catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    `;
    const child = spawn(tsxPath, ["--input-type=module", "-e", script], {
        cwd: workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
            ...environment,
        },
    });
    let stdout = "";
    let stderr = "";
    let didExit = false;
    let finalExitCode;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    child.once("exit", (code) => {
        didExit = true;
        finalExitCode = code;
    });

    const waitForStreamOutput = (
        getOutput,
        stream,
        pattern,
        fromIndex = 0,
    ) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`等待 CLI 输出超时：${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 10_000);
        const check = () => {
            const match = getOutput().slice(fromIndex).match(pattern);
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
            stream.off("data", check);
            child.off("exit", onExit);
        };
        stream.on("data", check);
        child.on("exit", onExit);
        check();
    });
    const waitForOutput = (pattern, fromIndex = 0) => waitForStreamOutput(
        () => stdout,
        child.stdout,
        pattern,
        fromIndex,
    );
    const waitForErrorOutput = (pattern, fromIndex = 0) => waitForStreamOutput(
        () => stderr,
        child.stderr,
        pattern,
        fromIndex,
    );

    const waitForExit = () => {
        if (didExit) return Promise.resolve(finalExitCode);
        return new Promise((resolve) => {
            child.once("exit", (code) => resolve(code));
        });
    };

    return {
        child,
        output: () => stdout,
        errorOutput: () => stderr,
        waitForOutput,
        waitForErrorOutput,
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
    const result = spawnSync(tsxPath, ["--input-type=module", "-e", script], {
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

test("普通 CLI 默认把同一轮 Typed Span 写入 Session SQLite", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-trace-"));
    const server = createArtifactCaptureServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cli = startCli(workingDirectory, {
        environment: { LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    });

    try {
        await cli.waitForOutput(/DKAgent 已创建 Session [0-9a-f-]{36}/);
        const outputIndex = cli.output().length;
        cli.child.stdin.write("记录 Trace\n");
        await cli.waitForOutput(/\{"memories":\[\]\}/, outputIndex);
    } finally {
        const exitPromise = cli.waitForExit();
        cli.child.stdin.end();
        assert.equal(await exitPromise, 0, cli.errorOutput());
        await new Promise((resolve, reject) => server.close((error) => {
            if (error) reject(error);
            else resolve();
        }));
    }

    const database = new Database(join(workingDirectory, ".dkagent/sessions.db"), { readonly: true });
    try {
        const traces = database.prepare("SELECT trace_id, session_id, status FROM traces").all();
        const spans = database.prepare(`
            SELECT trace_id, name, status, parent_span_id
            FROM trace_spans
            ORDER BY sequence
        `).all();
        assert.equal(traces.length, 1);
        assert.equal(traces[0].status, "ok");
        assert.ok(spans.length > 1);
        assert.equal(spans[0].name, "agent.turn");
        assert.equal(spans[0].parent_span_id, null);
        assert.ok(spans.every((span) => span.trace_id === traces[0].trace_id));
        assert.ok(spans.some((span) => span.name === "model.generate"));
        assert.equal(spans.some((span) => span.name.startsWith("memory.")), false);
        assert.ok(spans.every((span) => span.status !== "running"));
    } finally {
        database.close();
    }
});

test("CLI 不关闭调用方注入的 Session Store 和 Trace Sink", () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-owned-resources-"));
    const script = `
        import { runAgentCli } from ${JSON.stringify(cliModuleUrl)};
        import { SqliteSessionStore } from ${JSON.stringify(sessionModuleUrl)};
        import { Tracer } from ${JSON.stringify(traceModuleUrl)};
        const sessionStore = new SqliteSessionStore(".dkagent/sessions.db");
        let traceCloseCount = 0;
        const traceSink = { upsert() {}, close() { traceCloseCount += 1; } };
        await runAgentCli({ sessionStore, tracer: new Tracer(traceSink) });
        console.log(\`caller-owned:\${sessionStore.list().length}:\${traceCloseCount}\`);
        sessionStore.close();
        traceSink.close();
        console.log(\`caller-closed:\${traceCloseCount}\`);
    `;
    const result = spawnSync(tsxPath, ["--input-type=module", "-e", script], {
        cwd: workingDirectory,
        input: "",
        encoding: "utf8",
        timeout: 10_000,
        env: {
            ...process.env,
            LLM_API_KEY: "test-key",
            LLM_BASE_URL: "http://127.0.0.1:1",
        },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /caller-owned:1:0/);
    assert.match(result.stdout, /caller-closed:1/);
});

test("注入的 Trace Sink 写入失败不改变 CLI 回答", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-trace-failure-"));
    const server = createArtifactCaptureServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cli = startCli(workingDirectory, {
        runAgentOptions: `({ tracer: new Tracer({ upsert() { throw new Error("trace unavailable"); } }, {
            onWriteError() { console.error("trace-write-failed"); },
        }) })`,
        scriptPreamble: `import { Tracer } from ${JSON.stringify(traceModuleUrl)};`,
        environment: { LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1` },
    });

    try {
        await cli.waitForOutput(/DKAgent 已创建 Session [0-9a-f-]{36}/);
        const outputIndex = cli.output().length;
        cli.child.stdin.write("Trace 故障仍回答\n");
        await cli.waitForOutput(/\{"memories":\[\]\}/, outputIndex);
        await cli.waitForErrorOutput(/trace-write-failed/);
    } finally {
        const exitPromise = cli.waitForExit();
        cli.child.stdin.end();
        assert.equal(await exitPromise, 0, cli.errorOutput());
        await new Promise((resolve, reject) => server.close((error) => {
            if (error) reject(error);
            else resolve();
        }));
    }
});

test("CLI 为 /new 创建独立 ArtifactStore，并在 /switch 时由 Tool 观察到原 Store", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-artifact-store-"));
    const observedStoreLogPath = join(workingDirectory, "observed-artifact-stores.log");
    const server = createArtifactCaptureServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const cli = startCli(workingDirectory, {
        runAgentOptions: `(() => {
            let storeNumber = 0;
            return {
                artifactStoreFactory() {
                    const id = \`store-\${++storeNumber}\`;
                    return { id, put() { return id; }, get() { return undefined; } };
                },
            };
        })()`,
        scriptPreamble: `
            import { ToolRegistry } from ${JSON.stringify(toolRegistryModuleUrl)};
            const originalRegister = ToolRegistry.prototype.register;
            ToolRegistry.prototype.register = function(tool) {
                originalRegister.call(this, tool);
                if (tool.name === "read_file") {
                    originalRegister.call(this, {
                        name: "capture_store",
                        description: "capture",
                        parameters: { type: "object", properties: {}, additionalProperties: false },
                        async execute(_input, ctx) {
                            appendFileSync(${JSON.stringify(observedStoreLogPath)}, \`\${ctx.artifactStore.id}\\n\`);
                            return { success: true, data: { captured: true } };
                        },
                    });
                }
                return this;
            };
        `,
        environment: {
            LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        },
    });
    try {
        const startup = await cli.waitForOutput(
            /DKAgent 已创建 Session ([0-9a-f-]{36})/,
        );
        const firstSessionId = startup[1];
        await runArtifactCaptureTurn(cli, "first");

        const outputIndex = cli.output().length;
        cli.child.stdin.write("/new\n");
        const created = await cli.waitForOutput(
            /已创建 Session ([0-9a-f-]{36})/,
            outputIndex,
        );
        assert.notEqual(created[1], firstSessionId);
        await runArtifactCaptureTurn(cli, "second");

        const switchOutputIndex = cli.output().length;
        cli.child.stdin.write(`/switch ${firstSessionId}\n`);
        await cli.waitForOutput(
            new RegExp(`已切换到 Session ${firstSessionId}`),
            switchOutputIndex,
        );
        await runArtifactCaptureTurn(cli, "first-again");
    } finally {
        const exitPromise = cli.waitForExit();
        cli.child.stdin.end();
        const exitCode = await exitPromise;
        assert.equal(exitCode, 0, cli.errorOutput());
        await new Promise((resolve, reject) => server.close((error) => {
            if (error) reject(error);
            else resolve();
        }));
    }
    assert.deepEqual(readFileSync(observedStoreLogPath, "utf8").trim().split("\n"), [
        "store-1",
        "store-2",
        "store-1",
    ]);
});

function createArtifactCaptureServer() {
    return createServer(async (request, response) => {
        const body = await readRequestBody(request);
        const parsed = JSON.parse(body);
        const hasCaptureTool = parsed.tools?.some((tool) => (
            tool.function?.name === "capture_store"
        ));
        const latestMessage = parsed.messages?.at(-1);
        const event = hasCaptureTool && latestMessage?.role !== "tool"
            ? {
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: "capture-call",
                            function: { name: "capture_store", arguments: "{}" },
                        }],
                    },
                    finish_reason: "tool_calls",
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }
            : {
                choices: [{
                    delta: {
                        content: hasCaptureTool
                            ? "captured"
                            : JSON.stringify({ memories: [] }),
                    },
                    finish_reason: "stop",
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end("data: [DONE]\n\n");
    });
}

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

async function runArtifactCaptureTurn(cli, input) {
    const outputIndex = cli.output().length;
    cli.child.stdin.write(`${input}\n`);
    await cli.waitForOutput(/captured/, outputIndex);
}

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

test("CLI 切换结果决定后续用户消息写入的 Session，并支持 Tab 分隔参数", async () => {
    const workingDirectory = mkdtempSync(join(tmpdir(), "dkagent-cli-session-"));
    const cli = startCli(workingDirectory);
    let targetSessionId;

    try {
        const startup = await cli.waitForOutput(
            /DKAgent 已创建 Session ([0-9a-f-]{36})/,
        );
        targetSessionId = startup[1];

        let outputIndex = cli.output().length;
        cli.child.stdin.write("/new\n");
        await cli.waitForOutput(/已创建 Session [0-9a-f-]{36}/, outputIndex);

        outputIndex = cli.output().length;
        cli.child.stdin.write("/new\n");
        const created = await cli.waitForOutput(
            /已创建 Session ([0-9a-f-]{36})/,
            outputIndex,
        );
        const disposableSessionId = created[1];

        outputIndex = cli.output().length;
        cli.child.stdin.write(`/switch\t${targetSessionId}\n`);
        await cli.waitForOutput(
            new RegExp(`已切换到 Session ${targetSessionId}`),
            outputIndex,
        );

        let errorIndex = cli.errorOutput().length;
        cli.child.stdin.write("切换成功后的消息\n");
        await cli.waitForErrorOutput(/Agent 运行失败/, errorIndex);

        outputIndex = cli.output().length;
        cli.child.stdin.write("/switch missing-session\n");
        await cli.waitForOutput(/Session missing-session 不存在/, outputIndex);

        errorIndex = cli.errorOutput().length;
        cli.child.stdin.write("切换失败后的消息\n");
        await cli.waitForErrorOutput(/Agent 运行失败/, errorIndex);

        outputIndex = cli.output().length;
        cli.child.stdin.write(`/delete\t${disposableSessionId}\n`);
        await cli.waitForOutput(
            new RegExp(`已删除 Session ${disposableSessionId}`),
            outputIndex,
        );
    } finally {
        const exitPromise = cli.waitForExit();
        cli.child.stdin.end();
        const exitCode = await exitPromise;
        assert.equal(exitCode, 0, cli.errorOutput());
    }

    const database = new Database(
        join(workingDirectory, ".dkagent/sessions.db"),
        { readonly: true },
    );
    try {
        const rows = database.prepare(`
            SELECT session_id, message_json
            FROM session_messages
            ORDER BY id ASC
        `).all();
        assert.deepEqual(rows.map((row) => ({
            sessionId: row.session_id,
            message: JSON.parse(row.message_json),
        })), [
            {
                sessionId: targetSessionId,
                message: { role: "user", content: "切换成功后的消息" },
            },
            {
                sessionId: targetSessionId,
                message: { role: "user", content: "切换失败后的消息" },
            },
        ]);
    } finally {
        database.close();
    }
});
