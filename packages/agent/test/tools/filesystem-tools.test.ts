import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createReadFileTool } from "../../src/tools/filesystem/read-file.js";
import { createWriteFileTool } from "../../src/tools/filesystem/write-file.js";
import { createFindFilesTool } from "../../src/tools/filesystem/find-files.js";
import { createGrepFilesTool } from "../../src/tools/filesystem/grep-files.js";
import { resolveToolPath } from "../../src/tools/filesystem/path.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";

const context = (signal = new AbortController().signal): ToolContext => ({
    queryEngine: {} as QueryEngine,
    abortSignal: signal,
});

const withTempDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "dkagent-file-tools-"));
    try {
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

test("read_file 基于 cwd 读取指定行范围", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "notes.txt"), "one\ntwo\nthree\nfour", "utf8");
        const result = await createReadFileTool(cwd).execute(
            { path: "notes.txt", offset: 2, limit: 2 },
            context(),
        );

        assert.equal(result.success, true);
        assert.deepEqual(result.data, {
            path: join(cwd, "notes.txt"),
            content: "two\nthree",
            startLine: 2,
            endLine: 3,
            totalLines: 4,
        });
    });
});

test("read_file 允许绝对路径和 cwd 外的 ../ 路径", async () => {
    await withTempDir(async (parent) => {
        const cwd = join(parent, "project");
        const outside = join(parent, "outside.txt");
        await mkdir(cwd);
        await writeFile(outside, "outside", "utf8");
        const tool = createReadFileTool(cwd);

        const relativeResult = await tool.execute({ path: "../outside.txt" }, context());
        const absoluteResult = await tool.execute({ path: outside }, context());

        assert.equal(relativeResult.data?.content, "outside");
        assert.equal(absoluteResult.data?.content, "outside");
    });
});

test("read_file 拒绝非法 offset 和 limit", async () => {
    await withTempDir(async (cwd) => {
        const tool = createReadFileTool(cwd);
        const result = await tool.execute({ path: "notes.txt", offset: 0 }, context());

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "input_error");
    });
});

test("文件工具路径支持 ~ 展开", () => {
    assert.equal(resolveToolPath("~/notes.txt", "/tmp/project"), join(homedir(), "notes.txt"));
});

test("read_file 未指定 limit 时最多返回 500 行", async () => {
    await withTempDir(async (cwd) => {
        const lines = Array.from({ length: 501 }, (_, index) => `line-${index + 1}`);
        await writeFile(join(cwd, "long.txt"), lines.join("\n"), "utf8");

        const result = await createReadFileTool(cwd).execute({ path: "long.txt" }, context());

        assert.equal(result.data?.content.split("\n").length, 500);
        assert.equal(result.data?.totalLines, 501);
    });
});

test("write_file 创建父目录和新文件", async () => {
    await withTempDir(async (cwd) => {
        const path = join(cwd, "nested", "result.txt");
        const result = await createWriteFileTool(cwd).execute(
            { path: "nested/result.txt", content: "你好" },
            context(),
        );

        assert.equal(result.success, true);
        assert.equal(result.data?.overwritten, false);
        assert.equal(result.data?.bytesWritten, Buffer.byteLength("你好", "utf8"));
        assert.equal(await readFile(path, "utf8"), "你好");
    });
});

test("write_file 覆盖 cwd 外的既有文件", async () => {
    await withTempDir(async (parent) => {
        const cwd = join(parent, "project");
        const path = join(parent, "result.txt");
        await mkdir(cwd);
        await writeFile(path, "old", "utf8");

        const result = await createWriteFileTool(cwd).execute(
            { path: "../result.txt", content: "new" },
            context(),
        );

        assert.equal(result.data?.overwritten, true);
        assert.equal(await readFile(path, "utf8"), "new");
    });
});

test("write_file 在 overwrite=false 时拒绝覆盖既有文件", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "report.md"), "old", "utf8");
        const result = await createWriteFileTool(cwd).execute(
            { path: "report.md", content: "new", overwrite: false },
            context(),
        );

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "input_error");
        assert.match(result.error?.message ?? "", /目标文件已存在/);
        assert.equal(await readFile(join(cwd, "report.md"), "utf8"), "old");
    });
});

test("find_files 按 glob 查找并尊重 limit", async () => {
    await withTempDir(async (cwd) => {
        await mkdir(join(cwd, "src"));
        await writeFile(join(cwd, "src", "a.ts"), "a", "utf8");
        await writeFile(join(cwd, "src", "b.ts"), "b", "utf8");
        await writeFile(join(cwd, "src", "c.js"), "c", "utf8");

        const result = await createFindFilesTool(cwd).execute(
            { pattern: "**/*.ts", limit: 1 },
            context(),
        );

        assert.equal(result.success, true);
        assert.equal(result.data?.files.length, 1);
        assert.match(result.data?.files[0] ?? "", /\.ts$/);
    });
});

test("find_files 无匹配时成功返回空数组", async () => {
    await withTempDir(async (cwd) => {
        const result = await createFindFilesTool(cwd).execute(
            { pattern: "**/*.missing" },
            context(),
        );

        assert.deepEqual(result.data?.files, []);
    });
});

test("find_files 不存在的搜索目录返回 service_error", async () => {
    await withTempDir(async (cwd) => {
        const result = await createFindFilesTool(cwd).execute(
            { pattern: "**/*", path: "missing" },
            context(),
        );

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "service_error");
    });
});

test("find_files 默认尊重 .gitignore", async () => {
    await withTempDir(async (cwd) => {
        await mkdir(join(cwd, ".git"));
        await writeFile(join(cwd, ".gitignore"), "ignored.ts\n", "utf8");
        await writeFile(join(cwd, "visible.ts"), "visible", "utf8");
        await writeFile(join(cwd, "ignored.ts"), "ignored", "utf8");

        const result = await createFindFilesTool(cwd).execute(
            { pattern: "*.ts" },
            context(),
        );

        assert.deepEqual(result.data?.files, ["visible.ts"]);
    });
});

test("find_files 响应已中止的 AbortSignal", async () => {
    await withTempDir(async (cwd) => {
        const controller = new AbortController();
        controller.abort();
        const result = await createFindFilesTool(cwd).execute(
            { pattern: "**/*" },
            context(controller.signal),
        );

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "timeout");
    });
});

test("find_files 执行期间中止返回 timeout", async () => {
    await withTempDir(async (cwd) => {
        const controller = new AbortController();
        const resultPromise = createFindFilesTool(cwd).execute(
            { pattern: "**/*" },
            context(controller.signal),
        );
        controller.abort();
        const result = await resultPromise;

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "timeout");
    });
});

test("find_files 支持只有排除项的 glob", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "visible.ts"), "ts", "utf8");
        await writeFile(join(cwd, "hidden.js"), "js", "utf8");

        const result = await createFindFilesTool(cwd).execute(
            { pattern: "!**/*.js" },
            context(),
        );

        assert.deepEqual(result.data?.files, ["visible.ts"]);
    });
});

test("grep_files 返回匹配路径、行号和文本", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "notes.txt"), "first line\nneedle here\nlast line", "utf8");

        const result = await createGrepFilesTool(cwd).execute({ pattern: "needle" }, context());

        assert.equal(result.success, true);
        assert.deepEqual(result.data, {
            path: cwd,
            matches: [{ path: "notes.txt", line: 2, text: "needle here" }],
            total: 1,
        });
    });
});

test("grep_files 支持 glob 和 ignoreCase", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "notes.md"), "Needle in markdown", "utf8");
        await writeFile(join(cwd, "notes.txt"), "Needle in text", "utf8");

        const result = await createGrepFilesTool(cwd).execute(
            { pattern: "needle", glob: "*.md", ignoreCase: true },
            context(),
        );

        assert.deepEqual(result.data?.matches, [
            { path: "notes.md", line: 1, text: "Needle in markdown" },
        ]);
    });
});

test("grep_files 支持字面量搜索和 limit", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "special.txt"), "a.b\naxb\na.b", "utf8");

        const result = await createGrepFilesTool(cwd).execute(
            { pattern: "a.b", literal: true, limit: 1 },
            context(),
        );

        assert.deepEqual(result.data?.matches, [{ path: "special.txt", line: 1, text: "a.b" }]);
        assert.equal(result.data?.total, 1);
    });
});

test("grep_files 无匹配时成功返回空数组", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "notes.txt"), "hello", "utf8");

        const result = await createGrepFilesTool(cwd).execute({ pattern: "missing" }, context());

        assert.equal(result.success, true);
        assert.deepEqual(result.data?.matches, []);
        assert.equal(result.data?.total, 0);
    });
});

test("grep_files 响应已中止的 AbortSignal", async () => {
    await withTempDir(async (cwd) => {
        const controller = new AbortController();
        controller.abort();

        const result = await createGrepFilesTool(cwd).execute(
            { pattern: "needle" },
            context(controller.signal),
        );

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "timeout");
    });
});

test("createToolRegistry 注册文件工具，并把 cwd 下传给 read_file", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "notes.txt"), "from custom cwd", "utf8");
        const registry = createToolRegistry({ cwd, model: "fake-model" });

        assert.deepEqual(
            registry.list().map((tool) => tool.name),
            ["read_file", "find_files", "grep_files", "write_file", "analyze_interview"],
        );

        const result = await registry.resolve("read_file").execute({ path: "notes.txt" }, context());
        assert.equal(result.success, true);
        assert.equal(result.data?.content, "from custom cwd");
    });
});
