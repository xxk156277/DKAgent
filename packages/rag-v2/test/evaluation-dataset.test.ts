import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readEvaluationQuestions } from "../src/evaluation/evaluate.js";

const datasetPath = fileURLToPath(new URL("../eval/questions.v1.jsonl", import.meta.url));
const seedDatasetPath = fileURLToPath(new URL("../eval/questions.jsonl", import.meta.url));

test("questions.v1 包含 8 条正例和 2 条拒答例", async () => {
    const [questions, seedQuestions] = await Promise.all([
        readEvaluationQuestions(datasetPath),
        readEvaluationQuestions(seedDatasetPath),
    ]);

    assert.equal(questions.length, 10);
    assert.equal(new Set(questions.map((item) => item.query)).size, 10);

    const answerable = questions.filter((item) => !item.shouldRefuse);
    const refusals = questions.filter((item) => item.shouldRefuse);
    assert.equal(answerable.length, 8);
    assert.equal(refusals.length, 2);

    for (const item of answerable) {
        assert.ok(item.relevantSourcePaths.length > 0, item.query);
        assert.ok(item.expectedFacts.length > 0, item.query);
        assert.ok(item.expectedFacts.every((fact) => fact.trim().length > 0), item.query);
    }
    for (const item of refusals) {
        assert.deepEqual(item.relevantSourcePaths, [], item.query);
        assert.deepEqual(item.expectedFacts, [], item.query);
    }

    const seedQueries = new Set(seedQuestions.map((item) => item.query));
    for (const item of questions) {
        assert.equal(seedQueries.has(item.query), false, item.query);
    }
});
