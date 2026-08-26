import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownDocument } from "../src/parser.js";

const vault = "/vault";
const modifiedAt = new Date("2026-08-25T00:00:00Z");

test("按 H1/H2/H3 生成标题路径，代码块中的 # 不产生子块", () => {
    const markdown = `---\ntags: [rag]\n---\n# RAG\n简介\n\n## 检索\n正文\n\n\`\`\`bash\n# 不是标题\n\`\`\`\n\n### HNSW\n细节`;
    const parsed = parseMarkdownDocument("/vault/学习笔记/rag.md", vault, markdown, modifiedAt);
    assert.deepEqual(parsed.parent.frontmatter, { tags: ["rag"] });
    assert.deepEqual(
        parsed.chunks.map((chunk) => chunk.headingPath),
        [["RAG"], ["RAG", "检索"], ["RAG", "检索", "HNSW"]],
    );
});

test("同名标题通过 ordinal 保持不同稳定 ID", () => {
    const markdown = "# A\n## 示例\n一\n## 示例\n二";
    const first = parseMarkdownDocument("/vault/a.md", vault, markdown, modifiedAt);
    const second = parseMarkdownDocument("/vault/a.md", vault, markdown, modifiedAt);
    assert.equal(first.chunks[1]?.headingOrdinal, 0);
    assert.equal(first.chunks[2]?.headingOrdinal, 1);
    assert.notEqual(first.chunks[1]?.id, first.chunks[2]?.id);
    assert.deepEqual(
        first.chunks.map((chunk) => chunk.id),
        second.chunks.map((chunk) => chunk.id),
    );
});

test("无标题文件生成默认子块，长块按重叠窗口拆分", () => {
    const markdown = "纯正文".repeat(40);
    const parsed = parseMarkdownDocument("/vault/plain.md", vault, markdown, modifiedAt, {
        maxChunkChars: 60,
        overlapChars: 10,
    });
    assert.ok(parsed.chunks.length > 1);
    assert.deepEqual(parsed.chunks[0]?.headingPath, []);
    assert.ok(parsed.chunks.every((chunk) => chunk.content.length <= 60));
});

test("识别 Markdown 与 Obsidian 图片，并标记图片主导块", () => {
    const markdown = "# 流程\n![[截图.png|配置截图]]\n![结果](assets/result.png)";
    const parsed = parseMarkdownDocument("/vault/flow.md", vault, markdown, modifiedAt);
    assert.deepEqual(parsed.chunks[0]?.imageRefs, [
        { kind: "markdown", alt: "结果", target: "assets/result.png" },
        { kind: "obsidian", target: "截图.png", alt: "配置截图" },
    ]);
    assert.equal(parsed.chunks[0]?.needsVision, true);
});

test("文件路径决定 parentId，内容变化不改变父子身份", () => {
    const before = parseMarkdownDocument("/vault/a.md", vault, "# 标题\n旧内容", modifiedAt);
    const after = parseMarkdownDocument("/vault/a.md", vault, "# 标题\n新内容", modifiedAt);
    assert.equal(before.parent.id, after.parent.id);
    assert.equal(before.chunks[0]?.id, after.chunks[0]?.id);
    assert.notEqual(before.parent.contentHash, after.parent.contentHash);
});
