import assert from "node:assert/strict";
import test from "node:test";
import { calculateRecallAtK } from "../src/evaluation/evaluate.js";

test("Recall@3 按命中的相关父文档比例计算", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["A", "B", "C"]);

    assert.equal(result.recallAtK, 1 / 3);
    assert.deepEqual(result.matchedRelevantPaths, ["A"]);
});

test("Recall@3 在全部相关父文档进入 Top-3 时为 1", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["F", "A", "E"]);

    assert.equal(result.recallAtK, 1);
    assert.deepEqual(result.matchedRelevantPaths, ["A", "E", "F"]);
});

test("重复标注和重复返回不会抬高 Recall@3", () => {
    const result = calculateRecallAtK(["A", "A", "E"], ["A", "A", "B"]);

    assert.equal(result.recallAtK, 1 / 2);
    assert.deepEqual(result.matchedRelevantPaths, ["A"]);
});

test("没有命中任何相关父文档时 Recall@3 为 0", () => {
    const result = calculateRecallAtK(["A", "E", "F"], ["B", "C", "D"]);

    assert.equal(result.recallAtK, 0);
    assert.deepEqual(result.matchedRelevantPaths, []);
});
