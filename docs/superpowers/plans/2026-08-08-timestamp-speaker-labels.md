# Timestamp Speaker Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `split_qa_pairs` 支持“角色名 + 时间戳”标题，并保持现有冒号标签格式可用。

**Architecture:** 工具读取原文后先做确定性的逐行归一化，只转换说话人标题行，再复用现有格式检测和 QA 分割。Agent Loop 和工具协议保持不变。

**Tech Stack:** TypeScript、Node.js `node:test`、`node:assert/strict`

## Global Constraints

- 不引入新依赖，不使用 LLM 预处理。
- 只修改拆题工具及其 Phase 1 测试。
- 不提交 Git commit，除非用户另行要求。

---

### Task 1: 归一化时间戳角色标题

**Files:**
- Create: `test/phase1/split.test.ts`
- Modify: `src/tools/tool-item/split.ts`

**Interfaces:**
- Consumes: `splitQaTool.execute({ transcriptPath, format }, context)`
- Produces: 支持 `面试官 HH:MM`、`求职者 HH:MM`，并保留 `面试官:`、`候选人:` 支持。

- [ ] **Step 1: 写入失败测试**

```ts
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { QueryEngine } from "../../src/query-engine/queryEngine.js";
import { splitQaTool } from "../../src/tools/tool-item/split.js";

const context = {
  queryEngine: null as unknown as QueryEngine,
  abortSignal: new AbortController().signal,
};

test("splits interviewer and job-seeker timestamp headings", async () => {
  const result = await splitQaTool.execute({
    transcriptPath: resolve("test/test-short.md"),
    format: "auto",
  }, context);

  assert.equal(result.success, true);
  assert.equal(result.data?.totalQuestions, 1);
  assert.match(result.data?.pairs[0]?.question ?? "", /性能优化/);
  assert.match(result.data?.pairs[0]?.answer ?? "", /监控指标/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --import tsx --test test/phase1/split.test.ts`

Expected: FAIL，`result.success` 为 `false`。

- [ ] **Step 3: 实现最小逐行归一化**

在 `split.ts` 中增加角色定义和 `normalizeTranscript()`：统一换行与 Unicode 空格；只把冒号标签行或带 `HH:MM` 的角色标题行转换成 `面试官:` / `候选人:`。在格式检测和分割前调用它。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `node --import tsx --test test/phase1/split.test.ts`

Expected: PASS，拆出 1 组问答。

- [ ] **Step 5: 增加冒号格式回归测试**

```ts
test("keeps colon-labeled transcripts working", async () => {
  const result = await splitQaTool.execute({
    transcriptPath: resolve("test/fixtures/labeled-interview.txt"),
    format: "auto",
  }, context);

  assert.equal(result.success, true);
  assert.equal(result.data?.totalQuestions, 1);
});
```

- [ ] **Step 6: 运行回归测试**

Run: `node --import tsx --test test/phase1/split.test.ts`

Expected: 2 tests PASS。

### Task 2: 修正工具 Schema 必填字段

**Files:**
- Modify: `test/phase1/split.test.ts`
- Modify: `src/tools/tool-item/split.ts`

**Interfaces:**
- Consumes: `splitQaTool.parameters`
- Produces: JSON Schema 的 `required` 为 `["transcriptPath"]`。

- [ ] **Step 1: 写入失败测试**

```ts
test("requires transcriptPath in the tool schema", () => {
  assert.deepEqual(splitQaTool.parameters.required, ["transcriptPath"]);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --import tsx --test test/phase1/split.test.ts`

Expected: FAIL，实际值为 `["transcript"]`。

- [ ] **Step 3: 最小修复 Schema**

将 `required: ["transcript"]` 改为 `required: ["transcriptPath"]`。

- [ ] **Step 4: 完整验证**

Run: `npm run test:phase1 && npm run typecheck:phase1`

Expected: 所有测试通过，TypeScript 无错误。
