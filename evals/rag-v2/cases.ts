import type { Assertion, TestCase } from "promptfoo";
import type { EvaluationQuestion } from "../../packages/rag-v2/src/domain/types.js";

const CONTEXT_TRANSFORM = "output.context";
const ANSWER_TRANSFORM = "output.answer";

/** 将事实列表转换为 Promptfoo Context Recall 使用的参考答案。 */
export function formatReferenceFacts(expectedFacts: string[]): string {
  return expectedFacts.join("\n");
}

/** 为可回答问题创建四项语义评估，只记录分数，不预设门禁阈值。 */
function buildAnswerableAssertions(expectedFacts: string[]): Assertion[] {
  return [
    {
      type: "context-recall",
      value: formatReferenceFacts(expectedFacts),
      contextTransform: CONTEXT_TRANSFORM,
      metric: "Context Recall",
    },
    {
      type: "context-relevance",
      contextTransform: CONTEXT_TRANSFORM,
      metric: "Context Precision Proxy",
    },
    {
      type: "answer-relevance",
      transform: ANSWER_TRANSFORM,
      metric: "Answer Relevancy",
    },
    {
      type: "context-faithfulness",
      transform: ANSWER_TRANSFORM,
      contextTransform: CONTEXT_TRANSFORM,
      metric: "Faithfulness",
    },
  ];
}

/** 将现有黄金问题映射为 Promptfoo 测试用例。 */
export function buildPromptfooTests(questions: EvaluationQuestion[]): TestCase[] {
  return questions.map((question, index) => ({
    description: `${question.shouldRefuse ? "拒答" : "正例"}-${index + 1} ${question.query}`,
    vars: {
      query: question.query,
      expectedFacts: question.expectedFacts,
    },
    metadata: {
      shouldRefuse: question.shouldRefuse,
      relevantSourcePaths: question.relevantSourcePaths,
    },
    options: { runSerially: true },
    assert: question.shouldRefuse
      ? [{ type: "is-refusal", metric: "Refusal Accuracy" }]
      : buildAnswerableAssertions(question.expectedFacts),
  }));
}

