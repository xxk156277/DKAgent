import assert from "node:assert/strict";
import test from "node:test";
import { Bm25Index, tokenizeForBm25 } from "../src/retrieval/bm25.js";
import { reciprocalRankFusion } from "../src/retrieval/search.js";

test("BM25 同时支持中文词和英文错误码的精确匹配", () => {
    // 场景：Dense 可能弱化专有词，BM25 应把包含精确词的子块排在前面。
    const tokens = tokenizeForBm25("素材组 material_group_404 未生效");
    assert.ok(tokens.includes("素材"));
    assert.ok(tokens.includes("material_group_404"));

    const index = new Bm25Index([
        { id: "exact", text: "素材组报错 material_group_404，请检查配置" },
        { id: "semantic", text: "常见业务异常排查流程" },
    ]);
    assert.equal(index.search("material_group_404", 2)[0]?.id, "exact");
});

test("RRF 累加 Dense 和 BM25 排名，不混合两路原始分数", () => {
    // 场景：同一子块进入两路候选时，应获得两次排名贡献。
    const fused = reciprocalRankFusion(["dense-only", "both"], ["both", "bm25-only"]);
    assert.equal(fused[0]?.id, "both");
    assert.equal(fused[0]?.denseRank, 2);
    assert.equal(fused[0]?.bm25Rank, 1);
    assert.ok((fused[0]?.rrfScore ?? 0) > (fused[1]?.rrfScore ?? 0));
});
