import assert from "node:assert/strict";
import test from "node:test";
import type { EvaluationQuestion } from "../../packages/rag-v2/src/domain/types.js";
import { buildPromptfooTests, formatReferenceFacts } from "./cases.js";

test("正例映射为四项 RAG 语义指标", () => {
  const question: EvaluationQuestion = {
    query: "SSE 为什么适合流式输出？",
    relevantSourcePaths: ["SSE.md"],
    expectedFacts: ["SSE 是服务端单向推送", "连接会保持打开"],
    shouldRefuse: false,
  };

  const [testCase] = buildPromptfooTests([question]);

  assert.equal(testCase?.vars?.query, question.query);
  assert.deepEqual(
    testCase?.assert?.map((item) => typeof item === "string" ? item : item.type),
    ["context-recall", "context-relevance", "answer-relevance", "context-faithfulness"],
  );
  assert.equal(formatReferenceFacts(question.expectedFacts), "SSE 是服务端单向推送\n连接会保持打开");
});

test("拒答例只检查系统是否拒答", () => {
  const question: EvaluationQuestion = {
    query: "知识库里不存在的问题",
    relevantSourcePaths: [],
    expectedFacts: [],
    shouldRefuse: true,
  };

  const [testCase] = buildPromptfooTests([question]);

  assert.deepEqual(
    testCase?.assert?.map((item) => typeof item === "string" ? item : item.type),
    ["is-refusal"],
  );
});

