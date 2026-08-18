# Interview Analysis and Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在第一阶段 `StructuredInterview` 之上实现项目事实、文本表达、逐题分析、问题簇等权评分和两层 Markdown 暂定报告。

**Architecture:** LLM 只返回受 Zod 约束、带原文 ID 的语义判断；代码负责表达统计、证据校验、置信度上限、评分和 Markdown 渲染。所有单题结果保持独立，第三阶段的 Skill 才负责循环、暂停恢复和局部重跑。

**Tech Stack:** TypeScript、Node.js test runner、Zod、现有 `QueryEngine`、现有 `Tool` 协议。

## Global Constraints

- 不修改 Agent 入口、Tool 注册表、Session 或 Memory。
- 不调用真实模型；全部测试使用 `FakeTextProvider`。
- 项目题不要求参考答案；知识资料只作为可选输入。
- 原问题和原回答只读取 `StructuredInterview`，LLM 不得改写。
- 口头语、重复和长句只作为文字表达依据，不评价声音表现。
- 单题不适用维度为 `null`，不得按 0 分处理。
- 评分顺序固定为：单题 → 簇内平均 → 问题簇等权 → 五维固定权重。
- 暂定报告展示暂定总分；最终报告仍有高影响待确认项时拒绝生成。
- 本阶段完成后仍不注册 `diagnose-transcript` Skill。

---

### Task 1: Analysis Types and Deterministic Scoring

**Files:**

- Create: `packages/agent/src/interview/analysis-types.ts`
- Create: `packages/agent/src/interview/scoring.ts`
- Create: `packages/agent/test/interview/scoring.test.ts`
- Modify: `packages/agent/tsconfig.interview.json`

**Interfaces:**

- Consumes: `InterviewQuestion[]`、`QuestionCluster[]` from `src/interview/types.ts`。
- Produces: `QuestionAnalysis`、`InterviewScore`、`calculateQuestionScore()`、`scoreInterview()`，供后续 Tool 与报告使用。

- [ ] **Step 1: Write the failing scoring tests**

创建 `packages/agent/test/interview/scoring.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { calculateQuestionScore, scoreInterview } from "../../src/interview/scoring.js";
import type { QuestionAnalysis } from "../../src/interview/analysis-types.js";
import type { InterviewQuestion, QuestionCluster } from "../../src/interview/types.js";

const questions = [
    { id: "q-1", clusterId: "c-1", scored: true },
    { id: "q-2", clusterId: "c-1", scored: true },
    { id: "q-3", clusterId: "c-2", scored: true },
    { id: "q-4", clusterId: "c-3", scored: false },
] as InterviewQuestion[];

const clusters: QuestionCluster[] = [
    { id: "c-1", title: "项目", questionIds: ["q-1", "q-2"] },
    { id: "c-2", title: "知识", questionIds: ["q-3"] },
    { id: "c-3", title: "流程", questionIds: ["q-4"] },
];

function completed(
    questionId: string,
    contentQuality: number,
): QuestionAnalysis {
    return {
        status: "completed",
        questionId,
        clusterId: questionId === "q-3" ? "c-2" : "c-1",
        questionType: "project",
        strengths: [],
        issues: [],
        improvements: [],
        dimensionScores: {
            contentQuality,
            depthAndEvidence: null,
            analysisAndTradeoffs: null,
            followUpHandling: null,
            expressionQuality: null,
        },
        score: contentQuality,
        confidence: 0.8,
        confidenceReason: "证据充分",
        clarificationCandidates: [],
    };
}

test("单题只按适用维度重新归一化", () => {
    assert.equal(calculateQuestionScore({
        contentQuality: 80,
        depthAndEvidence: 60,
        analysisAndTradeoffs: null,
        followUpHandling: null,
        expressionQuality: null,
    }), 70);
});

test("先簇内平均再让问题簇等权", () => {
    const result = scoreInterview({
        questions,
        clusters,
        analyses: [completed("q-1", 40), completed("q-2", 80), completed("q-3", 100)],
    });

    assert.equal(result.clusterScores[0]?.dimensions.contentQuality, 60);
    assert.equal(result.dimensions.contentQuality, 80);
    assert.equal(result.totalScore, 80);
    assert.deepEqual(result.coverage, { analyzed: 3, expected: 3 });
});

test("失败题和流程题不按零分进入分母", () => {
    const result = scoreInterview({
        questions,
        clusters,
        analyses: [
            completed("q-1", 80),
            { status: "failed", questionId: "q-2", clusterId: "c-1", error: "模型失败" },
            completed("q-3", 100),
            { status: "not_scored", questionId: "q-4", clusterId: "c-3" },
        ],
    });

    assert.equal(result.totalScore, 90);
    assert.deepEqual(result.coverage, { analyzed: 2, expected: 3 });
});

test("没有任何可评分维度时拒绝生成分数", () => {
    assert.throws(
        () => scoreInterview({
            questions,
            clusters,
            analyses: [{
                ...completed("q-1", 80),
                dimensionScores: {
                    contentQuality: null,
                    depthAndEvidence: null,
                    analysisAndTradeoffs: null,
                    followUpHandling: null,
                    expressionQuality: null,
                },
                score: null,
            }],
        }),
        /没有可评分维度/,
    );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx tsx --test packages/agent/test/interview/scoring.test.ts
```

Expected: FAIL with `Cannot find module .../interview/scoring.js`.

- [ ] **Step 3: Add the analysis contracts**

创建 `packages/agent/src/interview/analysis-types.ts`：

```ts
import type { InterviewQuestionType } from "./types.js";

export type GlobalDimension =
    | "contentQuality"
    | "depthAndEvidence"
    | "analysisAndTradeoffs"
    | "followUpHandling"
    | "expressionQuality";

export type DimensionScores = Record<GlobalDimension, number | null>;
export type EvidenceImpact = "high" | "medium" | "low";

export interface ClarificationCandidate {
    factKey: string;
    question: string;
    affectedQuestionIds: string[];
    impact: EvidenceImpact;
}

export interface AnalysisObservation {
    id: string;
    text: string;
    impact: string;
    evidenceTurnIds: string[];
}

export interface AnalysisImprovement {
    issueId: string;
    text: string;
}

export interface CompletedQuestionAnalysis {
    status: "completed";
    questionId: string;
    clusterId: string;
    questionType: InterviewQuestionType;
    strengths: AnalysisObservation[];
    issues: AnalysisObservation[];
    improvements: AnalysisImprovement[];
    dimensionScores: DimensionScores;
    score: number | null;
    confidence: number;
    confidenceReason: string;
    clarificationCandidates: ClarificationCandidate[];
}

export interface FailedQuestionAnalysis {
    status: "failed";
    questionId: string;
    clusterId: string;
    error: string;
}

export interface NotScoredQuestionAnalysis {
    status: "not_scored";
    questionId: string;
    clusterId: string;
}

export type QuestionAnalysis =
    | CompletedQuestionAnalysis
    | FailedQuestionAnalysis
    | NotScoredQuestionAnalysis;

export type ProjectFactStatus = "stated" | "inferred" | "unknown";
export type ProjectFactCategory =
    | "background"
    | "responsibility"
    | "decision"
    | "implementation"
    | "metric"
    | "result";

export interface ProjectFact {
    key: string;
    category: ProjectFactCategory;
    value: string | null;
    status: ProjectFactStatus;
    evidenceTurnIds: string[];
    affectedQuestionIds: string[];
    clarificationQuestion: string | null;
    impact: EvidenceImpact;
}

export interface ProjectFactSet {
    clusterId: string;
    facts: ProjectFact[];
    clarificationCandidates: ClarificationCandidate[];
}

export interface ExpressionStats {
    fillerWords: Array<{ word: string; count: number }>;
    fillerCount: number;
    adjacentRepetitionCount: number;
    characterCount: number;
    sentenceCount: number;
    longSentenceCount: number;
}

export interface ExpressionAnalysis {
    questionId: string;
    stats: ExpressionStats;
    judgementStatus: "completed" | "failed";
    impact: "none" | "slight" | "significant" | "unknown";
    detail: string;
    evidenceQuotes: string[];
    score: number | null;
    confidence: number;
}

export interface ClusterScore {
    clusterId: string;
    dimensions: DimensionScores;
}

export interface InterviewScore {
    totalScore: number;
    dimensions: DimensionScores;
    clusterScores: ClusterScore[];
    coverage: { analyzed: number; expected: number };
}
```

- [ ] **Step 4: Implement deterministic scoring**

创建 `packages/agent/src/interview/scoring.ts`：

```ts
import type {
    DimensionScores,
    GlobalDimension,
    InterviewScore,
    QuestionAnalysis,
} from "./analysis-types.js";
import type { InterviewQuestion, QuestionCluster } from "./types.js";

export const DIMENSION_WEIGHTS: Record<GlobalDimension, number> = {
    contentQuality: 0.25,
    depthAndEvidence: 0.25,
    analysisAndTradeoffs: 0.2,
    followUpHandling: 0.15,
    expressionQuality: 0.15,
};

const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as GlobalDimension[];

function mean(values: number[]): number | null {
    return values.length
        ? values.reduce((total, value) => total + value, 0) / values.length
        : null;
}

function round(value: number | null): number | null {
    return value === null ? null : Math.round(value);
}

export function calculateQuestionScore(scores: DimensionScores): number | null {
    let weighted = 0;
    let weights = 0;
    for (const dimension of DIMENSIONS) {
        const score = scores[dimension];
        if (score === null) continue;
        if (!Number.isFinite(score) || score < 0 || score > 100) {
            throw new Error(`维度分数越界: ${dimension}`);
        }
        weighted += score * DIMENSION_WEIGHTS[dimension];
        weights += DIMENSION_WEIGHTS[dimension];
    }
    return weights ? Math.round(weighted / weights) : null;
}

export function scoreInterview(input: {
    questions: InterviewQuestion[];
    clusters: QuestionCluster[];
    analyses: QuestionAnalysis[];
}): InterviewScore {
    const completed = input.analyses.filter(
        (item) => item.status === "completed",
    );
    const completedByQuestion = new Map(
        completed.map((item) => [item.questionId, item]),
    );
    const clusterScores = input.clusters.flatMap((cluster) => {
        const items = cluster.questionIds
            .map((questionId) => completedByQuestion.get(questionId))
            .filter((item) => item !== undefined);
        if (!items.length) return [];
        const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
            dimension,
            round(mean(items.flatMap((item) => {
                const value = item.dimensionScores[dimension];
                return value === null ? [] : [value];
            }))),
        ])) as DimensionScores;
        return [{ clusterId: cluster.id, dimensions }];
    });
    const dimensions = Object.fromEntries(DIMENSIONS.map((dimension) => [
        dimension,
        round(mean(clusterScores.flatMap((cluster) => {
            const value = cluster.dimensions[dimension];
            return value === null ? [] : [value];
        }))),
    ])) as DimensionScores;
    const totalScore = calculateQuestionScore(dimensions);
    if (totalScore === null) throw new Error("没有可评分维度");
    return {
        totalScore,
        dimensions,
        clusterScores,
        coverage: {
            analyzed: completed.length,
            expected: input.questions.filter((question) => question.scored).length,
        },
    };
}
```

- [ ] **Step 5: Extend the interview typecheck scope and verify GREEN**

在 `packages/agent/tsconfig.interview.json` 的 `include` 中加入：

```json
"src/tools/tool-item/extract-project-facts.ts",
"src/tools/tool-item/analyze-expression.ts",
"src/tools/tool-item/analyze-answer.ts",
"src/tools/tool-item/generate-report.ts"
```

Run:

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
```

Expected: all interview tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/agent/src/interview/analysis-types.ts packages/agent/src/interview/scoring.ts packages/agent/test/interview/scoring.test.ts packages/agent/tsconfig.interview.json
git commit -m "feat: add interview scoring model"
```

---

### Task 2: Project Fact Extraction Tool

**Files:**

- Create: `packages/agent/src/tools/tool-item/extract-project-facts.ts`
- Create: `packages/agent/test/interview/extract-project-facts.test.ts`

**Interfaces:**

- Consumes: one `QuestionCluster`、its `InterviewQuestion[]`、the canonical `ParsedTranscript`。
- Produces: `createExtractProjectFactsTool(model)` returning `Tool<Input, ProjectFactSet>`。

- [ ] **Step 1: Write failing evidence-boundary tests**

创建测试，使用第一阶段 `parseTranscript()` 和 `FakeTextProvider`。核心用例必须使用以下输入与断言：

```ts
test("只接受当前项目簇内且能回到候选人原文的事实", async () => {
    const response = JSON.stringify({ facts: [
        {
            key: "project-a.role",
            category: "responsibility",
            value: "负责 DSL 渲染链路",
            status: "stated",
            evidenceTurnIds: ["turn-0002"],
            affectedQuestionIds: ["q-1"],
            clarificationQuestion: null,
            impact: "high",
        },
        {
            key: "project-a.metric",
            category: "metric",
            value: null,
            status: "unknown",
            evidenceTurnIds: [],
            affectedQuestionIds: ["q-2"],
            clarificationQuestion: "首屏指标具体提升多少？",
            impact: "high",
        },
    ] });
    const result = await createExtractProjectFactsTool("fake-model").execute(
        { transcript, cluster, questions },
        context(response),
    );
    assert.equal(result.success, true);
    assert.equal(result.data?.facts[0]?.status, "stated");
    assert.deepEqual(result.data?.clarificationCandidates, [{
        factKey: "project-a.metric",
        question: "首屏指标具体提升多少？",
        affectedQuestionIds: ["q-2"],
        impact: "high",
    }]);
});

test("拒绝引用其他问题簇或面试官轮次的事实", async () => {
    const response = JSON.stringify({ facts: [{
        key: "project-a.role",
        category: "responsibility",
        value: "负责全部架构",
        status: "stated",
        evidenceTurnIds: ["turn-0001"],
        affectedQuestionIds: ["q-outside"],
        clarificationQuestion: null,
        impact: "high",
    }] });
    const result = await createExtractProjectFactsTool("fake-model").execute(
        { transcript, cluster, questions },
        context(response),
    );
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "service_error");
});
```

测试文件完整定义 `transcript`、`cluster`、`questions` 和 `context()`；输入包含两个项目簇，确保越界检查不是只验证 ID 存在。

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test packages/agent/test/interview/extract-project-facts.test.ts
```

Expected: FAIL because `extract-project-facts.js` does not exist.

- [ ] **Step 3: Implement the Tool with strict Zod output**

实现要求：

```ts
export function createExtractProjectFactsTool(
    model: string,
): Tool<ExtractProjectFactsInput, ProjectFactSet>
```

Zod schema 对根对象和事实对象都调用 `.strict()`。执行逻辑固定为：

1. 校验 `cluster.questionIds` 与输入问题完全一致。
2. 允许的证据轮次仅为这些问题的 `answerTurnIds`。
3. `stated` 必须有非空 `value` 和至少一个候选人证据轮次。
4. `unknown` 必须为 `value=null`、无证据且有 `clarificationQuestion`。
5. `inferred` 必须有证据和 `clarificationQuestion`。
6. `affectedQuestionIds` 只能属于当前簇。
7. 从 `unknown` 和 `inferred` 且有问题文本的事实构造 `clarificationCandidates`。

系统提示词必须包含：

```text
stated 只表示候选人在原文明确陈述，不代表外部真实性已确认。
不得根据常识补全职责、指标、上线范围或项目结果。
unknown 的 value 必须为 null；所有证据只能引用输入中的候选人 turnId。
```

模型输入只传当前簇的问题 ID、原问题、原回答和候选人轮次，不传其他项目簇内容。

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
```

Expected: all interview tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/agent/src/tools/tool-item/extract-project-facts.ts packages/agent/test/interview/extract-project-facts.test.ts
git commit -m "feat: extract evidence-bound project facts"
```

---

### Task 3: Text Expression Analysis Tool

**Files:**

- Create: `packages/agent/src/interview/expression-statistics.ts`
- Create: `packages/agent/src/tools/tool-item/analyze-expression.ts`
- Create: `packages/agent/test/interview/analyze-expression.test.ts`

**Interfaces:**

- Consumes: `{ questionId: string; answer: string }`。
- Produces: `collectExpressionStats(answer)` and `createAnalyzeExpressionTool(model)` returning `ExpressionAnalysis`。

- [ ] **Step 1: Write failing deterministic and degraded-mode tests**

测试必须覆盖：

```ts
test("确定性统计保留口头语、重复和长句", () => {
    const longSentence = "这是一段".repeat(31) + "。";
    const result = collectExpressionStats(`嗯，然后然后开始处理。呃，${longSentence}`);
    assert.deepEqual(result.fillerWords, [
        { word: "嗯", count: 1 },
        { word: "呃", count: 1 },
        { word: "然后", count: 2 },
    ]);
    assert.equal(result.fillerCount, 4);
    assert.ok(result.adjacentRepetitionCount >= 1);
    assert.equal(result.longSentenceCount, 1);
});

test("LLM 只能基于原回答判断理解影响", async () => {
    const response = JSON.stringify({
        impact: "slight",
        detail: "重复连接词使句子略显拖沓",
        evidenceQuotes: ["然后然后"],
        score: 76,
        confidence: 0.86,
    });
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "嗯，然后然后我完成了灰度。" },
        context(response),
    );
    assert.equal(result.success, true);
    assert.equal(result.data?.score, 76);
    assert.match(provider.request?.systemPrompt ?? "", /不得评价.*语速.*音量/);
});

test("LLM 输出失败时保留统计并降级为 unknown", async () => {
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "嗯，我负责灰度。" },
        context("not-json"),
    );
    assert.equal(result.success, true);
    assert.equal(result.data?.judgementStatus, "failed");
    assert.equal(result.data?.impact, "unknown");
    assert.equal(result.data?.score, null);
    assert.equal(result.data?.stats.fillerCount, 1);
});

test("拒绝模型返回不在原回答中的证据片段", async () => {
    const response = JSON.stringify({
        impact: "significant",
        detail: "无法理解",
        evidenceQuotes: ["原文不存在"],
        score: 20,
        confidence: 0.9,
    });
    const result = await createAnalyzeExpressionTool("fake-model").execute(
        { questionId: "q-1", answer: "我负责灰度。" },
        context(response),
    );
    assert.equal(result.data?.judgementStatus, "failed");
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test packages/agent/test/interview/analyze-expression.test.ts
```

Expected: FAIL because both expression modules are missing.

- [ ] **Step 3: Implement deterministic statistics**

`collectExpressionStats()` 使用固定词表 `嗯、呃、额、然后、就是、那个`；按原字符串计数，不删除内容。句子按 `[。！？!?]` 分隔，非空片段计数；字符数使用去除空白后的长度；单句去除空白后超过 120 字计为长句。

相邻重复检测遍历 1～6 字片段，命中 `chunk + chunk` 时记录一次并跳过该重复区间，避免同一处被不同片段长度重复计数。

- [ ] **Step 4: Implement the LLM judgement Tool**

Tool 使用严格 schema：

```ts
const judgementSchema = z.object({
    impact: z.enum(["none", "slight", "significant"]),
    detail: z.string().min(1),
    evidenceQuotes: z.array(z.string().min(1)),
    score: z.number().min(0).max(100),
    confidence: z.number().min(0).max(1),
}).strict();
```

每个 `evidenceQuote` 必须是 `answer` 子串。任何 LLM、JSON、schema 或证据错误都返回 `success: true` 的降级结果：`judgementStatus="failed"`、`impact="unknown"`、`score=null`、`confidence=0`，并保留统计。

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
git add packages/agent/src/interview/expression-statistics.ts packages/agent/src/tools/tool-item/analyze-expression.ts packages/agent/test/interview/analyze-expression.test.ts
git commit -m "feat: analyze transcript expression evidence"
```

Expected: tests PASS, typecheck exits 0, commit succeeds.

---

### Task 4: Type-Specific Answer Analysis Tool

**Files:**

- Create: `packages/agent/src/interview/rubrics.ts`
- Create: `packages/agent/src/tools/tool-item/analyze-answer.ts`
- Create: `packages/agent/test/interview/analyze-answer.test.ts`

**Interfaces:**

- Consumes: question、cluster、cluster questions、optional `ProjectFactSet`、`ExpressionAnalysis`、optional reference texts。
- Produces: `createAnalyzeAnswerTool(model)` returning `CompletedQuestionAnalysis` for scored questions or `NotScoredQuestionAnalysis` for procedural questions。

- [ ] **Step 1: Write failing tests for project, knowledge, procedural and evidence rules**

测试场景：

```ts
test("项目题不依赖参考答案，并组合表达质量分", async () => {
    const result = await tool.execute({
        question: projectQuestion,
        cluster: projectCluster,
        clusterQuestions: [projectQuestion, followUpQuestion],
        projectFacts,
        expression: { ...expression, score: 72 },
        references: [],
    }, context(validProjectResponse));
    assert.equal(result.success, true);
    assert.equal(result.data?.status, "completed");
    if (result.data?.status !== "completed") return;
    assert.equal(result.data.dimensionScores.expressionQuality, 72);
    assert.equal(result.data.dimensionScores.followUpHandling, null);
    assert.ok(result.data.score !== null);
});

test("项目事实提取失败时置信度上限为 0.54", async () => {
    const result = await tool.execute({
        question: projectQuestion,
        cluster: projectCluster,
        clusterQuestions: [projectQuestion],
        projectFacts: null,
        expression,
        references: [],
    }, context({ ...validProjectResponse, confidence: 0.9 }));
    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.confidence, 0.54);
    }
});

test("知识题没有参考资料时置信度上限为 0.79", async () => {
    const result = await tool.execute(knowledgeInputWithoutReferences, context({
        ...validKnowledgeResponse,
        confidence: 0.95,
    }));
    assert.equal(result.data?.status, "completed");
    if (result.data?.status === "completed") {
        assert.equal(result.data.confidence, 0.79);
    }
});

test("流程题不调用 LLM 并直接返回 not_scored", async () => {
    const provider = new FakeTextProvider("不应读取");
    const result = await tool.execute(proceduralInput, contextWith(provider));
    assert.deepEqual(result.data, {
        status: "not_scored",
        questionId: proceduralInput.question.id,
        clusterId: proceduralInput.question.clusterId,
    });
    assert.equal(provider.request, undefined);
});

test("拒绝不存在的证据轮次和不适用维度分", async () => {
    const response = {
        ...validProjectResponse,
        issues: [{
            id: "issue-1",
            text: "缺少证据",
            impact: "结论不可信",
            evidenceTurnIds: ["turn-unknown"],
        }],
        dimensions: {
            contentQuality: 70,
            depthAndEvidence: 60,
            analysisAndTradeoffs: 50,
            followUpHandling: 80,
        },
    };
    const result = await tool.execute(primaryQuestionInput, context(response));
    assert.equal(result.success, false);
});
```

测试数据必须包含项目主问题和追问。主问题的 `followUpHandling` 必须为 `null`；簇中第二个及之后问题才允许该维度有分数。

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test packages/agent/test/interview/analyze-answer.test.ts
```

Expected: FAIL because `analyze-answer.js` does not exist.

- [ ] **Step 3: Define Rubrics and applicable dimensions**

`rubrics.ts` 导出：

```ts
export interface QuestionRubric {
    prompt: string;
    applicableDimensions: Array<Exclude<GlobalDimension, "expressionQuality">>;
}

export const QUESTION_RUBRICS: Record<Exclude<InterviewQuestionType, "procedural">, QuestionRubric> = {
    project: {
        prompt: "评价项目背景、本人职责、决策依据、实施细节、结果证据和追问一致性，不与标准答案比较。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    knowledge: {
        prompt: "评价技术事实、关键知识点和原理深度；只有提供参考资料时才据其核验。",
        applicableDimensions: ["contentQuality", "depthAndEvidence"],
    },
    open: {
        prompt: "评价问题澄清、约束、拆解、权衡、风险和验证。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    behavior: {
        prompt: "评价情境、个人行动、协作方式、结果和复盘。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
    coding: {
        prompt: "评价思路、实际产出、样例验证、边界和复杂度。",
        applicableDimensions: ["contentQuality", "depthAndEvidence", "analysisAndTradeoffs"],
    },
};
```

代码先取题型 Rubric 的适用维度，再根据问题在 `cluster.questionIds` 中的位置决定 `followUpHandling`：索引 0 必须为 `null`，索引大于 0 时对所有非流程题加入适用维度。

- [ ] **Step 4: Implement strict answer analysis**

LLM schema 只包含四个语义维度，不允许返回 `expressionQuality` 或总分：

```ts
const responseSchema = z.object({
    strengths: z.array(observationSchema).max(2),
    issues: z.array(observationSchema).max(3),
    improvements: z.array(z.object({
        issueId: z.string().min(1),
        text: z.string().min(1),
    }).strict()),
    dimensions: z.object({
        contentQuality: z.number().min(0).max(100).nullable(),
        depthAndEvidence: z.number().min(0).max(100).nullable(),
        analysisAndTradeoffs: z.number().min(0).max(100).nullable(),
        followUpHandling: z.number().min(0).max(100).nullable(),
    }).strict(),
    confidence: z.number().min(0).max(1),
    confidenceReason: z.string().min(1),
    clarificationCandidates: z.array(clarificationSchema),
}).strict();
```

代码校验：

1. 所有 strength/issue 证据只能引用当前问题的 prompt/answer turn IDs。
2. 每个 improvement 的 `issueId` 必须存在；每个 issue 必须恰有一个 improvement。
3. Rubric 不适用维度必须为 `null`。
4. 主问题 `followUpHandling=null`。
5. `expressionQuality` 只取 `expression.score`。
6. 通过 `calculateQuestionScore()` 计算总分。
7. 项目事实为 `null` 时置信度 `Math.min(value, 0.54)`。
8. 知识题无 references 时置信度 `Math.min(value, 0.79)`。
9. clarification 只能引用当前簇 questionId。

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
git add packages/agent/src/interview/rubrics.ts packages/agent/src/tools/tool-item/analyze-answer.ts packages/agent/test/interview/analyze-answer.test.ts
git commit -m "feat: analyze interview answers by question type"
```

Expected: tests PASS, typecheck exits 0, commit succeeds.

---

### Task 5: Structured Provisional Report and Markdown Renderer

**Files:**

- Modify: `packages/agent/src/interview/analysis-types.ts`
- Replace: `packages/agent/src/tools/tool-item/generate-report.ts`
- Create: `packages/agent/test/interview/generate-report.test.ts`
- Modify: `desginDocs/02-sop-agent-nodes.md`

**Interfaces:**

- Consumes: `StructuredInterview`、all `QuestionAnalysis[]`、`ProjectFactSet[]`、`stage`。
- Produces: `createGenerateReportTool(model)` returning `{ report: InterviewReport; markdown: string }` and pure `renderInterviewReport(report)`。

- [ ] **Step 1: Add report contracts to `analysis-types.ts` in the failing test branch**

追加以下类型；这是测试编译所需的契约，不实现行为：

```ts
export interface ReportReferenceItem {
    text: string;
    questionIds: string[];
}

export interface ReportQuestionItem {
    questionId: string;
    originalQuestion: string;
    originalAnswer: string;
    label: string;
    issues: string[];
    improvements: string[];
    score: number | null;
    confidenceLabel: "高" | "中" | "低" | null;
    confidenceReason: string | null;
    status: "completed" | "failed" | "not_scored";
}

export interface InterviewReport {
    stage: "provisional" | "final";
    notice: string | null;
    score: InterviewScore;
    summaryStatus: "completed" | "failed";
    levelSummary: string;
    strengths: ReportReferenceItem[];
    coreIssues: ReportReferenceItem[];
    priorityImprovements: ReportReferenceItem[];
    pendingClarifications: ClarificationCandidate[];
    questions: ReportQuestionItem[];
}
```

- [ ] **Step 2: Write failing report tests**

测试覆盖：

```ts
test("暂定报告展示暂定总分、覆盖率和完整问题顺序", async () => {
    const result = await createGenerateReportTool("fake-model").execute({
        structuredInterview,
        analyses,
        projectFactSets,
        stage: "provisional",
    }, context(validSummary));
    assert.equal(result.success, true);
    assert.equal(result.data?.report.stage, "provisional");
    assert.match(result.data?.report.notice ?? "", /暂定总分.*可能调整/);
    assert.equal(result.data?.report.questions.length, structuredInterview.questions.length);
    assert.match(result.data?.markdown ?? "", /已分析：2\/3/);
    assert.ok(
        result.data!.markdown.indexOf("原问题")
        < result.data!.markdown.indexOf("原回答"),
    );
    assert.ok(
        result.data!.markdown.indexOf("原回答")
        < result.data!.markdown.indexOf("标签："),
    );
});

test("待确认项按事实键合并、high 优先且最多五条", async () => {
    const result = await tool.execute(inputWithDuplicateClarifications, context(validSummary));
    const pending = result.data?.report.pendingClarifications ?? [];
    assert.ok(pending.length <= 5);
    assert.equal(pending[0]?.impact, "high");
    assert.equal(new Set(pending.map((item) => item.factKey)).size, pending.length);
});

test("最终报告存在 high 待确认项时拒绝生成", async () => {
    const result = await tool.execute({ ...baseInput, stage: "final" }, context(validSummary));
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

test("总结引用未知问题时降级但保留分数和问题列表", async () => {
    const result = await tool.execute(baseInput, context({
        ...validSummary,
        coreIssues: [{ text: "无来源结论", questionIds: ["q-unknown"] }],
    }));
    assert.equal(result.success, true);
    assert.equal(result.data?.report.summaryStatus, "failed");
    assert.ok(result.data?.report.score.totalScore !== null);
    assert.equal(result.data?.report.questions.length, structuredInterview.questions.length);
});

test("流程题和失败题保留但不显示分数", async () => {
    const result = await tool.execute(baseInput, context(validSummary));
    const procedural = result.data?.report.questions.find((item) => item.status === "not_scored");
    const failed = result.data?.report.questions.find((item) => item.status === "failed");
    assert.equal(procedural?.score, null);
    assert.equal(failed?.score, null);
    assert.match(result.data?.markdown ?? "", /不参与评分/);
    assert.match(result.data?.markdown ?? "", /分析失败/);
});
```

- [ ] **Step 3: Verify RED against the old report implementation**

Run:

```bash
npx tsx --test packages/agent/test/interview/generate-report.test.ts
```

Expected: FAIL because the old `generate-report.ts` does not export `createGenerateReportTool` and uses the obsolete report contract.

- [ ] **Step 4: Replace the old report implementation**

新的 `generate-report.ts` 必须：

1. 拒绝未知或重复 `analysis.questionId`。
2. 调用 `scoreInterview()`，失败题和流程题不进入分母。
3. 合并项目事实与单题的 clarification：过滤 low、按 `factKey` 合并 question IDs、high 优先、受影响题数倒序、取前 5。
4. `stage=final` 且仍有 high 时返回 `input_error`。
5. 调用一次 `queryModelJson()` 生成 `levelSummary`、strengths、coreIssues、priorityImprovements；每项只能引用已存在问题 ID。
6. 总结调用或证据校验失败时返回成功降级报告，`summaryStatus="failed"`，文字数组为空，不影响分数和问题列表。
7. 逐题列表严格按 `structuredInterview.questions` 顺序组装，原问题和原回答直接复制。

置信度标签函数固定为：

```ts
export function confidenceLabel(value: number): "高" | "中" | "低" {
    if (value >= 0.8) return "高";
    if (value >= 0.55) return "中";
    return "低";
}
```

Markdown 渲染每题固定顺序：

```md
### Q1

原问题：...

原回答：...

标签：问题簇 / 题型

问题：...

改进方向：...

分数：78/100

置信度：中（缺少量化结果证据）
```

流程题最后两行替换为 `分数：不参与评分`；失败题替换为 `分数：分析失败`。不要截断原回答。

- [ ] **Step 5: Update the implementation status document**

在 `desginDocs/02-sop-agent-nodes.md` 的“当前实现状态”中更新：

```md
- 已实现：长稿结构化、项目事实提取、文本表达分析、逐题分析、问题簇等权评分和暂定两层报告。
- 已验证：FakeProvider 场景覆盖项目题、知识题、开放题、流程题、部分失败、证据越界和固定 Markdown 顺序。
- 尚未接入：Agent入口、`diagnose-transcript` Skill、用户确认后的局部重跑、最终报告和Memory时间线。
```

- [ ] **Step 6: Run focused and regression verification**

Run:

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
npm run test:phase1 -w @dkagent/agent
git diff --check
```

Expected:

- All interview tests PASS.
- Interview typecheck exits 0.
- Phase 1 remains at the previously accepted baseline: 16 PASS, 1 existing System Prompt assertion FAIL; no additional failure.
- `git diff --check` exits 0.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/agent/src/interview/analysis-types.ts packages/agent/src/tools/tool-item/generate-report.ts packages/agent/test/interview/generate-report.test.ts desginDocs/02-sop-agent-nodes.md
git commit -m "feat: generate provisional interview reports"
```

---

## Final Verification

- [ ] Run fresh feature tests and typecheck:

```bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
```

- [ ] Confirm no unrelated files changed:

```bash
git status --short
git diff --stat main...HEAD
git diff --check main...HEAD
```

- [ ] Confirm the runtime boundary remains intact:

```bash
git diff main...HEAD -- packages/agent/src/tools/index.ts packages/agent/src/agent packages/agent/src/skills packages/agent/src/memory
```

Expected: no second-stage changes in Agent、Skill、Tool registry or Memory paths.

- [ ] Record the known baseline separately:

```bash
npm run test:phase1 -w @dkagent/agent
```

Expected: only the previously accepted `System Prompt 约束普通聊天和诊断 Tool 的使用边界` assertion fails. Any other failure blocks completion.
