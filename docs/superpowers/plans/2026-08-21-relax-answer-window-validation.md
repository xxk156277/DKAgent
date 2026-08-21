# Relax Answer Window Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许模型返回回答窗口的子集或空数组，同时拒绝重复、非候选人和窗口外回答轮次。

**Architecture:** 保留现有回答窗口计算，把“模型集合必须等于窗口集合”改为“模型集合必须是窗口集合的无重复子集”。不改变输入输出、Prompt 或下游物化逻辑。

**Tech Stack:** TypeScript、Node.js test runner、Zod

## Global Constraints

- 仅修改回答窗口校验和对应测试。
- 不自动补全模型遗漏的回答轮次。
- 不实现工具日志、独立调用入口或 Prompt 重写。

---

### Task 1: 放宽回答窗口集合校验

**Files:**
- Modify: `packages/agent/test/interview/structurer.test.ts:163-181`
- Modify: `packages/agent/src/interview/structurer.ts:73-82,239-246`

**Interfaces:**
- Consumes: `ModelQuestion.answerTurnIds: string[]` 与程序计算的 `expectedAnswerTurnIds: string[]`
- Produces: `structureInterview(input): Promise<StructureOutput>`，公共签名不变

- [ ] **Step 1: 写失败测试**

将既有严格用例改为以下行为，并增加重复引用用例：

```ts
test("回答不能引用回答窗口之外的候选人轮次", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = ["turn-0004"];
    await assert.rejects(() => runWith(relation), /回答引用超出回答窗口/);
});

test("非空回答窗口允许返回空回答轮次", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = [];
    const { result } = await runWith(relation);
    assert.deepEqual(result.questions[0]?.answerTurnIds, []);
});

test("回答窗口允许只绑定部分候选人轮次", async () => {
    const result = await runInterrupted(["turn-0002"]);
    assert.deepEqual(result.questions[0]?.answerTurnIds, ["turn-0002"]);
});

test("回答轮次不能重复", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = ["turn-0002", "turn-0002"];
    await assert.rejects(() => runWith(relation), /回答轮次重复/);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx tsx --test packages/agent/test/interview/structurer.test.ts`

Expected: 新行为用例失败；旧实现仍抛出“回答轮次必须完整覆盖回答窗口”。

- [ ] **Step 3: 写最小实现**

删除不再使用的 `sameMembers`，将集合相等校验替换为：

```ts
const duplicateAnswerTurnIds = findDuplicates(draft.question.answerTurnIds);
if (duplicateAnswerTurnIds.length) {
    throw new Error(`回答轮次重复: ${duplicateAnswerTurnIds.join(",")}`);
}
const expectedAnswerTurnIdSet = new Set(expectedAnswerTurnIds);
const outOfWindowAnswerTurnIds = draft.question.answerTurnIds.filter(
    (turnId) => !expectedAnswerTurnIdSet.has(turnId),
);
if (outOfWindowAnswerTurnIds.length) {
    throw new Error(`回答引用超出回答窗口: ${outOfWindowAnswerTurnIds.join(",")}`);
}
```

- [ ] **Step 4: 验证 GREEN**

Run: `npx tsx --test packages/agent/test/interview/structurer.test.ts`

Expected: 全部通过。

Run: `npm run test:interview -w @dkagent/agent && npm run typecheck:interview -w @dkagent/agent && git diff --check`

Expected: 命令退出码为 0。

- [ ] **Step 5: 提交实现**

```bash
git add packages/agent/src/interview/structurer.ts packages/agent/test/interview/structurer.test.ts
git commit -m "fix(agent): relax answer window validation"
```
