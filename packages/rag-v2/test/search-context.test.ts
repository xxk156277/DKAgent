import assert from "node:assert/strict";
import test from "node:test";
import type { SearchHit } from "../src/domain/types.js";
import { selectParentContext } from "../src/generation/context.js";
import { aggregateByParent } from "../src/retrieval/search.js";
import type { StoredDocument } from "../src/storage/database.js";

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

test("前一块超过预算时仍优先保留命中块", () => {
    // 场景：不能因为前一块先占满预算，导致真正命中的证据被截掉。
    const chunks = ["前".repeat(200), "命中证据", "后续步骤"].map((content, sequence) => ({
        id: String(sequence),
        parentId: "p",
        sourcePath: "p.md",
        sequence,
        headingPath: [content.slice(0, 4)],
        headingOrdinal: 0,
        splitIndex: 0,
        content,
        contentHash: content,
        imageRefs: [],
        needsVision: false,
    }));
    const document: StoredDocument = {
        parent: {
            id: "p",
            sourcePath: "p.md",
            title: "p",
            content: "长".repeat(500),
            contentHash: "h",
            frontmatter: {},
            modifiedAt: new Date(),
        },
        chunks,
    };

    const selected = selectParentContext(document, "1", 30);
    assert.ok(selected.includes("命中证据"));
    assert.ok(selected.length <= 30);
});

test("相邻长块的 overlap 在上下文中只保留一次", () => {
    // 场景：切块时引入的重叠只用于召回，生成上下文不应重复浪费预算。
    const overlap = "共同边界";
    const chunks = [`前文${overlap}`, `${overlap}命中`, "后文"].map((content, sequence) => ({
        id: String(sequence),
        parentId: "p",
        sourcePath: "p.md",
        sequence,
        headingPath: [],
        headingOrdinal: 0,
        splitIndex: sequence,
        content,
        contentHash: content,
        imageRefs: [],
        needsVision: false,
    }));
    const document: StoredDocument = {
        parent: {
            id: "p",
            sourcePath: "p.md",
            title: "p",
            content: "长".repeat(500),
            contentHash: "h",
            frontmatter: {},
            modifiedAt: new Date(),
        },
        chunks,
    };

    const selected = selectParentContext(document, "1", 100);
    assert.equal(selected.match(/共同边界/g)?.length, 1);
});

test("预算只比命中块多一个字符时也不裁掉命中内容", () => {
    // 场景：邻居和分隔符不能反过来挤占命中块的保底预算。
    const chunks = ["前", "完整命中证据", "后"].map((content, sequence) => ({
        id: String(sequence),
        parentId: "p",
        sourcePath: "p.md",
        sequence,
        headingPath: [],
        headingOrdinal: 0,
        splitIndex: 0,
        content,
        contentHash: content,
        imageRefs: [],
        needsVision: false,
    }));
    const document: StoredDocument = {
        parent: {
            id: "p",
            sourcePath: "p.md",
            title: "p",
            content: "长".repeat(100),
            contentHash: "h",
            frontmatter: {},
            modifiedAt: new Date(),
        },
        chunks,
    };

    assert.equal(selectParentContext(document, "1", "完整命中证据".length + 1), "完整命中证据");
});
