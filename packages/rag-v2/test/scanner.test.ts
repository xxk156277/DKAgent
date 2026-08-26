import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanVault } from "../src/ingestion/scanner.js";

test("空文件被报告但不会作为有效索引保留", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rag-scanner-"));
    try {
        await fs.writeFile(path.join(root, "empty.md"), "", "utf8");
        await fs.writeFile(path.join(root, "content.md"), "# 标题\n正文", "utf8");
        const result = await scanVault(root, ["*.md"]);
        assert.deepEqual(result.seenPaths, ["content.md", "empty.md"]);
        assert.deepEqual(
            result.documents.map((item) => item.parent.sourcePath),
            ["content.md"],
        );
        assert.deepEqual(result.retainedPaths, []);
        assert.equal(result.skippedFiles[0]?.path, "empty.md");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
