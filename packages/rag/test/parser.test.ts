import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeMarkdown } from "../src/parser.js";

test("解析二三级 Q 标题和连续的回答区块", () => {
  const markdown = `# React

## Q：什么是闭包？

**新手答**：函数里面的变量。

**高手答**：函数与其词法环境的组合。

第二行答案。

**差距在哪**：需要说明词法作用域。

### Q: 什么是事件循环？

**高手答**：协调调用栈与任务队列。

**考察点**：异步执行模型。
`;

  const result = parseKnowledgeMarkdown(
    markdown,
    "01-javascript\\runtime.md",
  );

  assert.equal(result.skipped.length, 0);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    id: "01-javascript/runtime.md#q-1",
    dimension: "01-javascript",
    question: "什么是闭包？",
    noviceAnswer: "函数里面的变量。",
    expertAnswer: "函数与其词法环境的组合。\n\n第二行答案。",
    gapAnalysis: "需要说明词法作用域。",
    sourceFile: "01-javascript/runtime.md",
    content:
      "问题：什么是闭包？\n\n高手答：函数与其词法环境的组合。\n\n第二行答案。\n\n差距分析：需要说明词法作用域。",
  });
  assert.equal(result.entries[1]?.id, "01-javascript/runtime.md#q-2");
  assert.equal(result.entries[1]?.gapAnalysis, "异步执行模型。");
});

test("缺少高手回答时加入跳过队列", () => {
  const result = parseKnowledgeMarkdown(
    "## Q：你了解 FTS5 吗？\n\n**新手答**：不了解。",
    "database/sqlite.md",
  );

  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.skipped, [
    {
      blockIndex: 1,
      question: "你了解 FTS5 吗？",
      reason: "missing_expert_answer",
    },
  ]);
});

test("相同文件重复解析会生成稳定 ID", () => {
  const markdown = "## Q: 问题\n\n**高手答**：答案";

  const first = parseKnowledgeMarkdown(markdown, "general/a.md");
  const second = parseKnowledgeMarkdown(markdown, "general/a.md");

  assert.equal(first.entries[0]?.id, second.entries[0]?.id);
});
