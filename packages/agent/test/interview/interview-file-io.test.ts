import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { QueryEngine } from "../../src/query-engine/query-engine.js";
import { readWholeText, writeTimestampedInterviewReport } from "../../src/skills/interview-file-io.js";
import { createReadFileTool } from "../../src/tools/filesystem/read-file.js";
import { createWriteFileTool } from "../../src/tools/filesystem/write-file.js";
import type { ToolContext } from "../../src/tools/types.js";

const context = (): ToolContext => ({
    queryEngine: {} as QueryEngine,
    abortSignal: new AbortController().signal,
});

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "dkagent-interview-io-"));
    try {
        await run(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("readWholeText 分页读取超过500行且不丢最后一行", async () => {
    await withTempDir(async (cwd) => {
        const lines = Array.from({ length: 1003 }, (_, index) => `line-${index + 1}`);
        await writeFile(join(cwd, "long.md"), lines.join("\n"), "utf8");
        const result = await readWholeText(
            createReadFileTool(cwd),
            "long.md",
            context(),
            500,
        );

        assert.equal(result.totalLines, 1003);
        assert.equal(result.content.split("\n").length, 1003);
        assert.match(result.content, /line-1003$/);
    });
});

test("报告同秒重名时追加序号且不覆盖", async () => {
    await withTempDir(async (cwd) => {
        const transcriptPath = join(cwd, "一面.md");
        await writeFile(transcriptPath, "原稿", "utf8");
        const tool = createWriteFileTool(cwd);
        const now = new Date("2026-08-18T10:20:30+08:00");
        const first = await writeTimestampedInterviewReport({
            tool, transcriptPath, markdown: "报告一", context: context(), now,
        });
        const second = await writeTimestampedInterviewReport({
            tool, transcriptPath, markdown: "报告二", context: context(), now,
        });

        assert.notEqual(first, second);
        assert.equal(await readFile(first, "utf8"), "报告一");
        assert.equal(await readFile(second, "utf8"), "报告二");
        assert.match(second, /-2\.md$/);
    });
});
