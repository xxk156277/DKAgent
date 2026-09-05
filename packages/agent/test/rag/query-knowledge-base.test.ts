import assert from "node:assert/strict";
import test from "node:test";
import type { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createToolRegistry } from "../../src/tools/index.js";
import {
    createQueryKnowledgeBaseTool,
    type KnowledgeRetriever,
} from "../../src/tools/rag/query-knowledge-base.js";
import type { ToolContext } from "../../src/tools/types.js";

function toolContext(signal = new AbortController().signal): ToolContext {
    return {
        queryEngine: {} as QueryEngine,
        abortSignal: signal,
    };
}

test("知识库 Tool 返回可追溯的编号证据，不在 Tool 内生成答案", async () => {
    let received: { query: string; topK: number } | undefined;
    const retriever: KnowledgeRetriever = {
        async query(query, topK) {
            received = { query, topK };
            return {
                evidence: "[1] C-前端学习/node/SSE.md#区别\nSSE 是单向推送。",
                sources: [{
                    index: 1,
                    sourcePath: "C-前端学习/node/SSE.md",
                    headingPath: ["区别"],
                    content: "SSE 是单向推送。",
                    similarity: 0.81,
                    needsVision: false,
                }],
                durationMs: 18,
                embeddingTokens: 11,
            };
        },
    };

    const result = await createQueryKnowledgeBaseTool(retriever).execute(
        { query: "SSE 和普通 HTTP 有什么区别", topK: 3 },
        toolContext(),
    );

    assert.deepEqual(received, { query: "SSE 和普通 HTTP 有什么区别", topK: 3 });
    assert.equal(result.success, true);
    assert.match(result.data?.evidence ?? "", /\[1\].*SSE\.md/);
    assert.equal(result.data?.sources[0]?.headingPath[0], "区别");
    assert.equal("answer" in (result.data ?? {}), false);
});

test("知识库 Tool 拒绝空问题和越界 topK，且不调用 Retriever", async () => {
    let callCount = 0;
    const retriever: KnowledgeRetriever = {
        async query() {
            callCount += 1;
            throw new Error("不应调用");
        },
    };
    const tool = createQueryKnowledgeBaseTool(retriever);

    const empty = await tool.execute({ query: "   " }, toolContext());
    const tooLarge = await tool.execute({ query: "问题", topK: 6 }, toolContext());

    assert.equal(empty.error?.code, "input_error");
    assert.equal(tooLarge.error?.code, "input_error");
    assert.equal(callCount, 0);
});

test("ToolRegistry 仅在注入 Retriever 时注册知识库 Tool", () => {
    const withoutRag = createToolRegistry({ model: "fake-model" });
    const withRag = createToolRegistry({
        model: "fake-model",
        knowledgeRetriever: { async query() { throw new Error("测试占位"); } },
    });

    assert.equal(withoutRag.has("query_knowledge_base"), false);
    assert.equal(withRag.has("query_knowledge_base"), true);
});
