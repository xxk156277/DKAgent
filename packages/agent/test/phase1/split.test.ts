import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { QueryEngine } from "../../src/query-engine/query-engine.js";
import { splitQaTool } from "../../src/tools/tool-item/split.js";

const context = {
    queryEngine: null as unknown as QueryEngine,
    abortSignal: new AbortController().signal,
};

test("splits interviewer and job-seeker timestamp headings", async () => {
    const result = await splitQaTool.execute({
        transcriptPath: resolve("packages/agent/test/test-short.md"),
        format: "auto",
    }, context);

    assert.equal(result.success, true);
    assert.equal(result.data?.totalQuestions, 1);
    assert.match(result.data?.pairs[0]?.question ?? "", /性能优化/);
    assert.match(result.data?.pairs[0]?.answer ?? "", /监控指标/);
});

test("keeps colon-labeled transcripts working", async () => {
    const result = await splitQaTool.execute({
        transcriptPath: resolve("packages/agent/test/fixtures/labeled-interview.txt"),
        format: "auto",
    }, context);

    assert.equal(result.success, true);
    assert.equal(result.data?.totalQuestions, 1);
});

test("requires transcriptPath in the tool schema", () => {
    assert.deepEqual(splitQaTool.parameters.required, ["transcriptPath"]);
});
