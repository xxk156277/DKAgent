import assert from "node:assert/strict";
import test from "node:test";
import { aggregateByParent } from "../src/search.js";
import { selectParentContext } from "../src/context.js";
import type { SearchHit } from "../src/types.js";
import type { StoredDocument } from "../src/database.js";

function hit(parentId: string, chunkId: string, similarity: number): SearchHit {
    return {
        parentId,
        chunkId,
        similarity,
        sourcePath: `${parentId}.md`,
        documentTitle: parentId,
        headingPath: [chunkId],
        content: chunkId,
        needsVision: false,
    };
}

test("子块候选按父文档聚合，并保留每个父文档最高分块", () => {
    const result = aggregateByParent(
        [hit("a", "a1", 0.8), hit("a", "a2", 0.9), hit("b", "b1", 0.85), hit("c", "c1", 0.7)],
        2,
    );
    assert.deepEqual(
        result.map((item) => item.chunkId),
        ["a2", "b1"],
    );
});

test("短父文档返回全文，长父文档仅返回命中块及相邻块", () => {
    const chunks = ["一", "二", "三", "四"].map((content, sequence) => ({
        id: String(sequence),
        parentId: "p",
        sourcePath: "p.md",
        sequence,
        headingPath: [content],
        headingOrdinal: 0,
        splitIndex: 0,
        content: content.repeat(20),
        contentHash: content,
        imageRefs: [],
        needsVision: false,
    }));
    const base: StoredDocument = {
        parent: {
            id: "p",
            sourcePath: "p.md",
            title: "p",
            content: "短全文",
            contentHash: "h",
            frontmatter: {},
            modifiedAt: new Date(),
        },
        chunks,
    };
    assert.equal(selectParentContext(base, "1", 100), "短全文");
    const long = { ...base, parent: { ...base.parent, content: "长".repeat(200) } };
    const selected = selectParentContext(long, "2", 100);
    assert.ok(selected.includes("二"));
    assert.ok(selected.includes("三"));
    assert.ok(selected.includes("四"));
    assert.ok(!selected.includes("一"));
    assert.ok(selected.length <= 100);
});
