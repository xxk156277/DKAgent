# Interview Agent and Skill Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过 DKAgent 自然语言定位并确认面试文字稿，由单一 `analyze_interview` 业务 Tool 启动 `diagnose-transcript` Skill，输出聊天摘要和不覆盖已有文件的暂定 Markdown 报告。

**Architecture:** Agent 只看到基础文件 Tool 与 `analyze_interview`；业务 Tool 校验输入并调用确定性 Skill；Skill 顺序编排现有面试分析原子能力。知识检索通过可选端口注入，JD岗位匹配在报告阶段独立降级，不改变通用面试分数。

**Tech Stack:** TypeScript、Node.js Test Runner、Zod、现有 QueryEngine/ToolRegistry、SQLite FTS5 KnowledgeSearch。

## Global Constraints

- 本阶段只生成 `provisional` 报告。
- 不实现用户确认后的局部重跑、`final` 报告、诊断 Session 状态或 Memory 时间线。
- 不实现上传接口；业务 Tool 只接收已确认的本地绝对路径。
- Agent 未确认实际路径前不得调用 `analyze_interview`，不得扫描整个用户目录。
- 内部原子分析能力不得注册到 Agent 公共 `ToolRegistry`。
- 原始文字稿、口头语、重复、停顿、卡壳和完整原回答不得被删除或截断。
- JD岗位匹配不生成分数，不修改通用总分或五维分数。
- 报告写入必须排他创建，绝不覆盖已有文件。
- 所有测试使用 FakeProvider 或注入的假依赖，不调用真实模型和真实 Embedding 服务。
- 当前验收基线：面试域 70/70；Agent全量 183/184，仅旧 Prompt 断言失败；全包 typecheck 因旧 Skill/Tool 文件有 19 个错误。

---

## File Map

### 新增

- `packages/agent/src/skills/interview-file-io.ts`：分页完整读取与排他报告写入。
- `packages/agent/src/skills/interview-reference-retriever.ts`：知识检索端口及 FTS 适配器。
- `packages/agent/src/tools/tool-item/analyze-interview.ts`：Agent可见的业务 Tool。
- `packages/agent/test/interview/interview-file-io.test.ts`：长文件与不覆盖测试。
- `packages/agent/test/interview/diagnose-transcript-skill.test.ts`：Skill顺序、降级和精简输出测试。
- `packages/agent/test/interview/analyze-interview.test.ts`：业务输入与完整闭环测试。
- `packages/agent/test/phase1/interview-agent-routing.test.ts`：Agent多轮找文件、确认和启动分析测试。

### 修改

- `packages/agent/src/tools/filesystem/write-file.ts`：支持兼容的 `overwrite` 开关。
- `packages/agent/test/tools/filesystem-tools.test.ts`：排他创建与Registry清单。
- `packages/agent/src/interview/analysis-types.ts`：元数据、JD匹配与状态。
- `packages/agent/src/tools/tool-item/generate-report.ts`：元数据/JD输入、证据校验和渲染。
- `packages/agent/test/interview/fake-provider.ts`：支持连续模型响应。
- `packages/agent/test/interview/generate-report.test.ts`：元数据与JD回归。
- `packages/agent/src/skills/diagnose-transcript.ts`：用新SOP替换旧未完成实现。
- `packages/agent/src/tools/index.ts`：注册业务 Tool，移除旧 `split_qa_pairs`。
- `packages/agent/src/config.ts`：可选 `KNOWLEDGE_DATABASE_PATH`。
- `packages/agent/src/knowledge/index.ts`：导出数据库打开函数。
- `packages/agent/src/cli/run.ts`：模型、可选知识检索和数据库生命周期接线。
- `packages/agent/src/agent/prompt.ts`：文件查找、路径确认、元数据/JD行为契约。
- `packages/agent/test/phase1/agent-loop.test.ts`：替换过时Prompt断言。
- `packages/agent/tsconfig.interview.json`：纳入新Skill和业务 Tool。
- `desginDocs/02-sop-agent-nodes.md`、`desginDocs/index.md`：同步实现状态。

### 删除

- `packages/agent/src/skills/types.ts`
- `packages/agent/src/tools/tool-item/split.ts`
- `packages/agent/src/tools/tool-item/analyze_content.ts`
- `packages/agent/src/tools/tool-item/analyze_speech.ts`
- `packages/agent/src/tools/tool-item/knowledge-base.ts`
- `packages/agent/test/phase1/split.test.ts`

这些文件只服务旧的未完成面试流程；新Skill接线后无调用方，且其中三个文件正在阻塞全包typecheck。删除它们属于本阶段替换旧业务链，不是无关清理。

---

### Task 1: Long File Reading and Non-overwriting Report Writes

**Files:**

- Modify: `packages/agent/src/tools/filesystem/write-file.ts`
- Modify: `packages/agent/test/tools/filesystem-tools.test.ts`
- Create: `packages/agent/src/skills/interview-file-io.ts`
- Create: `packages/agent/test/interview/interview-file-io.test.ts`
- Modify: `packages/agent/tsconfig.interview.json`

**Interfaces:**

- Consumes: existing `ToolContext`, `createReadFileTool(cwd)`, `createWriteFileTool(cwd)`.
- Produces:

```ts
export interface WriteFileInput {
    path: string;
    content: string;
    overwrite?: boolean;
}

export async function readWholeText(
    tool: Tool<ReadFileInput, ReadFileOutput>,
    path: string,
    context: ToolContext,
    pageSize?: number,
): Promise<{ path: string; content: string; totalLines: number }>;

export async function writeTimestampedInterviewReport(input: {
    tool: Tool<WriteFileInput, WriteFileOutput>;
    transcriptPath: string;
    markdown: string;
    context: ToolContext;
    now: Date;
}): Promise<string>;
```

- [ ] **Step 1: Write failing filesystem tests**

在 `filesystem-tools.test.ts` 增加：

```ts
test("write_file 在 overwrite=false 时拒绝覆盖既有文件", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "report.md"), "old", "utf8");
        const result = await createWriteFileTool(cwd).execute(
            { path: "report.md", content: "new", overwrite: false },
            context(),
        );

        assert.equal(result.success, false);
        assert.equal(result.error?.code, "input_error");
        assert.match(result.error?.message ?? "", /目标文件已存在/);
        assert.equal(await readFile(join(cwd, "report.md"), "utf8"), "old");
    });
});

test("write_file 默认仍允许覆盖以保持兼容", async () => {
    await withTempDir(async (cwd) => {
        await writeFile(join(cwd, "report.md"), "old", "utf8");
        const result = await createWriteFileTool(cwd).execute(
            { path: "report.md", content: "new" },
            context(),
        );

        assert.equal(result.success, true);
        assert.equal(result.data?.overwritten, true);
        assert.equal(await readFile(join(cwd, "report.md"), "utf8"), "new");
    });
});
```

- [ ] **Step 2: Verify the overwrite tests fail**

Run:

```bash
npx tsx --test packages/agent/test/tools/filesystem-tools.test.ts
```

Expected: 新的 `overwrite=false` 用例 FAIL，因为现有 Tool 仍覆盖文件。

- [ ] **Step 3: Implement atomic exclusive writes**

在 `write-file.ts` 中：

```ts
export interface WriteFileInput {
    path: string;
    content: string;
    overwrite?: boolean;
}
```

Schema增加：

```ts
overwrite: {
    type: "boolean",
    description: "是否允许覆盖既有文件，默认 true",
},
```

写入逻辑使用：

```ts
const overwrite = input.overwrite ?? true;
try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, {
        encoding: "utf8",
        flag: overwrite ? "w" : "wx",
    });
    return {
        success: true,
        data: {
            path,
            bytesWritten: Buffer.byteLength(input.content, "utf8"),
            overwritten: overwrite && existedBeforeWrite,
        },
    };
} catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return {
            success: false,
            error: { code: "input_error", message: `目标文件已存在: ${path}` },
        };
    }
    return toolFailure(error);
}
```

`existedBeforeWrite` 延续现有 `access(path)` 判断；`overwrite=false` 的安全性依赖 `wx`，不依赖先检查后写入。

- [ ] **Step 4: Write failing full-read and collision tests**

在 `interview-file-io.test.ts` 创建临时目录并增加：

```ts
test("readWholeText 分页读取超过500行且不丢最后一行", async () => {
    await withTempDir(async (cwd) => {
        const lines = Array.from({ length: 1003 }, (_, index) => `line-${index + 1}`);
        await writeFile(join(cwd, "long.md"), lines.join("\n"), "utf8");
        const result = await readWholeText(
            createReadFileTool(cwd),
            "long.md",
            context(),
            500,
        );

        assert.equal(result.totalLines, 1003);
        assert.equal(result.content.split("\n").length, 1003);
        assert.match(result.content, /line-1003$/);
    });
});

test("报告同秒重名时追加序号且不覆盖", async () => {
    await withTempDir(async (cwd) => {
        const transcriptPath = join(cwd, "一面.md");
        await writeFile(transcriptPath, "原稿", "utf8");
        const tool = createWriteFileTool(cwd);
        const now = new Date("2026-08-18T10:20:30+08:00");
        const first = await writeTimestampedInterviewReport({
            tool, transcriptPath, markdown: "报告一", context: context(), now,
        });
        const second = await writeTimestampedInterviewReport({
            tool, transcriptPath, markdown: "报告二", context: context(), now,
        });

        assert.notEqual(first, second);
        assert.equal(await readFile(first, "utf8"), "报告一");
        assert.equal(await readFile(second, "utf8"), "报告二");
        assert.match(second, /-2\.md$/);
    });
});
```

- [ ] **Step 5: Verify helper tests fail**

Run:

```bash
npx tsx --test packages/agent/test/interview/interview-file-io.test.ts
```

Expected: FAIL because `interview-file-io.ts` does not exist.

- [ ] **Step 6: Implement the two file helpers**

`readWholeText` 必须从 `offset=1` 开始，按 `pageSize` 调用 `read_file`，使用 `endLine + 1` 推进，直到 `endLine >= totalLines`。每页使用 `\n` 连接；任何 Tool 失败都抛出其错误消息。

`writeTimestampedInterviewReport` 必须：

```ts
const parsed = parse(input.transcriptPath);
const stamp = formatLocalTimestamp(input.now);
const base = join(parsed.dir, `${parsed.name}-面试分析-${stamp}`);

for (let attempt = 1; attempt <= 100; attempt += 1) {
    const path = `${base}${attempt === 1 ? "" : `-${attempt}`}.md`;
    const result = await input.tool.execute({
        path,
        content: input.markdown,
        overwrite: false,
    }, input.context);
    if (result.success) return result.data!.path;
    if (!result.error?.message.startsWith("目标文件已存在:")) {
        throw new Error(result.error?.message ?? "报告写入失败");
    }
}
throw new Error("同一时间戳下的报告文件冲突过多");
```

`formatLocalTimestamp` 输出固定 `YYYYMMDD-HHmmss`，所有字段用两位数字补零。

- [ ] **Step 7: Run focused verification**

Run:

```bash
npx tsx --test packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/interview/interview-file-io.test.ts
npm run typecheck:interview -w @dkagent/agent
git diff --check
```

Expected: focused tests PASS，面试类型检查 PASS，diff check无输出。

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/agent/src/tools/filesystem/write-file.ts packages/agent/src/skills/interview-file-io.ts packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/interview/interview-file-io.test.ts packages/agent/tsconfig.interview.json
git commit -m "feat: safely persist complete interview reports"
```

---

### Task 2: Report Metadata and Evidence-bound JD Matching

**Files:**

- Modify: `packages/agent/src/interview/analysis-types.ts`
- Modify: `packages/agent/src/tools/tool-item/generate-report.ts`
- Modify: `packages/agent/test/interview/fake-provider.ts`
- Modify: `packages/agent/test/interview/generate-report.test.ts`

**Interfaces:**

- Extends `GenerateReportInput` with `metadata?` and `jdText?`.
- Extends `InterviewReport` with:

```ts
export interface InterviewMetadata {
    company: string | null;
    position: string | null;
    date: string | null;
    round: string | null;
}

export interface JobMatchItem {
    text: string;
    jdEvidenceQuote: string;
    questionIds: string[];
}

export interface JobMatchAnalysis {
    summary: string;
    matches: JobMatchItem[];
    gaps: JobMatchItem[];
}

export interface InterviewReport {
    stage: "provisional" | "final";
    notice: string | null;
    metadata: InterviewMetadata;
    jobMatchStatus: "not_provided" | "completed" | "failed";
    jobMatch: JobMatchAnalysis | null;
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

- [ ] **Step 1: Make FakeTextProvider scriptable**

先改测试辅助类型，但不改业务代码：

```ts
export class FakeTextProvider implements LLMProvider {
    public readonly name = "fake";
    public request: ModelRequest | undefined;
    public readonly requests: ModelRequest[] = [];
    private readonly contents: string[];

    public get remainingResponses(): number {
        return this.contents.length;
    }

    public constructor(content: string | string[]) {
        this.contents = Array.isArray(content) ? [...content] : [content];
    }

    public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        this.request = request;
        this.requests.push(request);
        const content = this.contents.shift();
        if (content === undefined) throw new Error("FakeTextProvider 没有可用响应");
        yield { type: "text_delta", content };
        yield {
            type: "message_end",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "end_turn",
        };
    }
}
```

保留现有 `countTokens()`。

- [ ] **Step 2: Write failing metadata and JD tests**

在 `generate-report.test.ts` 增加三组测试：

```ts
test("报告渲染已确认元数据，缺失字段显示未提供", async () => {
    const provider = new FakeTextProvider(JSON.stringify(validSummary));
    const result = await createGenerateReportTool("fake-model").execute({
        ...baseInput(),
        metadata: { company: "字节跳动", round: "一面" },
    }, contextFor(provider));

    assert.equal(result.data?.report.metadata.company, "字节跳动");
    assert.equal(result.data?.report.metadata.position, null);
    assert.match(result.data?.markdown ?? "", /公司：字节跳动/);
    assert.match(result.data?.markdown ?? "", /岗位：未提供/);
});

test("JD岗位匹配引用JD原文且不改变总分", async () => {
    const jobMatch = {
        summary: "项目经验与岗位要求部分匹配。",
        matches: [{
            text: "具备复杂前端项目经验",
            jdEvidenceQuote: "负责复杂前端系统建设",
            questionIds: ["q-1"],
        }],
        gaps: [],
    };
    const provider = new FakeTextProvider([
        JSON.stringify(validSummary),
        JSON.stringify(jobMatch),
    ]);
    const withJd = await createGenerateReportTool("fake-model").execute({
        ...baseInput(),
        jdText: "岗位要求：负责复杂前端系统建设。",
    }, contextFor(provider));
    const withoutJd = await createGenerateReportTool("fake-model").execute(
        baseInput(),
        contextFor(new FakeTextProvider(JSON.stringify(validSummary))),
    );

    assert.equal(withJd.success, true);
    assert.equal(withJd.data?.report.jobMatchStatus, "completed");
    assert.equal(withJd.data?.report.jobMatch?.matches[0]?.questionIds[0], "q-1");
    assert.equal(
        withJd.data?.report.score.totalScore,
        withoutJd.data?.report.score.totalScore,
    );
    assert.equal(provider.requests.length, 2);
});

test("JD证据非法时仅岗位匹配降级", async () => {
    const provider = new FakeTextProvider([
        JSON.stringify(validSummary),
        JSON.stringify({
            summary: "错误结论",
            matches: [{
                text: "不存在的要求",
                jdEvidenceQuote: "JD中没有这句话",
                questionIds: ["q-1"],
            }],
            gaps: [],
        }),
    ]);
    const result = await createGenerateReportTool("fake-model").execute({
        ...baseInput(),
        jdText: "岗位要求：负责复杂前端系统建设。",
    }, contextFor(provider));

    assert.equal(result.success, true);
    assert.equal(result.data?.report.summaryStatus, "completed");
    assert.equal(result.data?.report.jobMatchStatus, "failed");
    assert.equal(result.data?.report.jobMatch, null);
    assert.match(result.data?.markdown ?? "", /岗位匹配：不可评价/);
});
```

`contextFor(provider)` 返回既有 `ToolContext`。总分断言必须比较同一 `baseInput` 的有JD与无JD结果，不能硬编码分数或修改评分实现。

- [ ] **Step 3: Verify report tests fail**

Run:

```bash
npx tsx --test packages/agent/test/interview/generate-report.test.ts
```

Expected: 新类型、输入字段和JD章节尚不存在，测试FAIL。

- [ ] **Step 4: Implement metadata normalization and rendering**

`GenerateReportInput` 增加：

```ts
metadata?: Partial<Record<"company" | "position" | "date" | "round", string>>;
jdText?: string;
```

规范化函数：

```ts
function normalizeMetadata(input: GenerateReportInput["metadata"]): InterviewMetadata {
    const value = (key: keyof InterviewMetadata) => input?.[key]?.trim() || null;
    return {
        company: value("company"),
        position: value("position"),
        date: value("date"),
        round: value("round"),
    };
}
```

Markdown在“报告状态”后渲染公司、岗位、日期、轮次。`null`固定显示“未提供”。

- [ ] **Step 5: Implement a separate JD model call and evidence validation**

新增严格Schema：

```ts
const jobMatchItemSchema = z.object({
    text: z.string().min(1),
    jdEvidenceQuote: z.string().min(1),
    questionIds: z.array(z.string().min(1)).min(1),
}).strict();

const jobMatchSchema = z.object({
    summary: z.string().min(1),
    matches: z.array(jobMatchItemSchema),
    gaps: z.array(jobMatchItemSchema),
}).strict();
```

通用总结调用保持原逻辑。只有 `jdText?.trim()` 非空时再调用一次 `queryModelJson()`：

```ts
let jobMatchStatus: InterviewReport["jobMatchStatus"] = "not_provided";
let jobMatch: JobMatchAnalysis | null = null;
const jdText = input.jdText?.trim();
if (jdText) {
    jobMatchStatus = "failed";
    try {
        const candidate = await queryModelJson({
            queryEngine: ctx.queryEngine,
            model,
            abortSignal: ctx.abortSignal,
            schema: jobMatchSchema,
            systemPrompt: [
                "只比较JD要求与本次面试中可观察到的证据，严格输出JSON。",
                "jdEvidenceQuote必须逐字复制自JD。",
                "questionIds必须引用输入中存在的问题。",
                "没有面试证据时不得声称满足或不满足。",
                "不得生成分数，不得修改通用面试结论。",
            ].join("\n"),
            userContent: JSON.stringify({ jdText, questions }),
        });
        validateJobMatch(candidate, jdText, knownQuestionIds);
        jobMatch = candidate;
        jobMatchStatus = "completed";
    } catch {
        jobMatch = null;
    }
}
```

`validateJobMatch` 必须逐项验证JD子串和已知questionId。失败只影响岗位匹配。

- [ ] **Step 6: Render the optional JD section**

规则：

```ts
function renderJobMatch(report: InterviewReport): string[] {
    if (report.jobMatchStatus === "not_provided") return [];
    if (report.jobMatchStatus === "failed") {
        return ["## 岗位匹配", "", "岗位匹配：不可评价"];
    }
    return [
        "## 岗位匹配",
        "",
        report.jobMatch!.summary,
        "",
        "### 匹配项",
        "",
        ...renderJobItems(report.jobMatch!.matches),
        "",
        "### 差距",
        "",
        ...renderJobItems(report.jobMatch!.gaps),
    ];
}
```

每项显示文本、JD逐字证据和问题ID；空数组显示“- 无”。

- [ ] **Step 7: Run report regression**

Run:

```bash
npx tsx --test packages/agent/test/interview/generate-report.test.ts
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
git diff --check
```

Expected: 新增用例PASS，现有70个面试测试无回归。

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/agent/src/interview/analysis-types.ts packages/agent/src/tools/tool-item/generate-report.ts packages/agent/test/interview/fake-provider.ts packages/agent/test/interview/generate-report.test.ts
git commit -m "feat: add evidence-bound interview job matching"
```

---

### Task 3: Deterministic `diagnose-transcript` Skill

**Files:**

- Replace: `packages/agent/src/skills/diagnose-transcript.ts`
- Delete: `packages/agent/src/skills/types.ts`
- Create: `packages/agent/src/skills/interview-reference-retriever.ts`
- Create: `packages/agent/test/interview/diagnose-transcript-skill.test.ts`
- Modify: `packages/agent/tsconfig.interview.json`

**Interfaces:**

```ts
export interface InterviewReferenceRetriever {
    retrieve(question: string, abortSignal: AbortSignal): Promise<string[]>;
}

export interface DiagnoseTranscriptInput {
    transcriptPath: string;
    metadata?: Partial<Record<keyof InterviewMetadata, string>>;
    jdText?: string;
    jdPath?: string;
}

export interface DiagnoseTranscriptOutput {
    reportPath: string;
    levelSummary: string;
    totalScore: number;
    analyzedCount: number;
    questionCount: number;
    pendingClarifications: ClarificationCandidate[];
    jobMatchSummary: string | null;
}

export interface DiagnoseTranscriptSkill {
    readonly name: "diagnose-transcript";
    execute(
        input: DiagnoseTranscriptInput,
        context: ToolContext,
    ): Promise<ToolResult<DiagnoseTranscriptOutput>>;
}
```

`createDiagnoseTranscriptSkill(dependencies)` 注入 read/write Tool、五个现有分析 Tool、`structureInterview`、可选知识检索器和时钟。

- [ ] **Step 1: Write failing orchestration tests with fake dependencies**

测试至少覆盖：

1. 固定调用顺序：read → preprocess → structure → project facts → expression → references → answer → report → write。
2. 流程题不调用表达模型和知识检索，结果为 `not_scored`。
3. 单题 `analyze_answer` 失败转成 `FailedQuestionAnalysis` 并继续。
4. 项目事实提取失败时项目题仍分析，传入 `projectFacts: null`。
5. 知识检索抛错时知识题传入空 references。
6. `jdPath` 使用完整读取结果；`jdText` 与 `jdPath` 不同时接受。
7. 返回对象只有精简字段，不含 `markdown`、`report` 或 `questions`。
8. 不调用 SessionStore 或 Memory接口；依赖类型中也不出现它们。

Fake Tool使用统一构造器：

```ts
function fakeTool<TInput, TOutput>(input: {
    name: string;
    calls: string[];
    result: (value: TInput) => ToolResult<TOutput> | Promise<ToolResult<TOutput>>;
}): Tool<TInput, TOutput> {
    return {
        name: input.name,
        description: input.name,
        parameters: { type: "object" },
        async execute(value) {
            input.calls.push(input.name);
            return input.result(value);
        },
    };
}
```

- [ ] **Step 2: Verify Skill tests fail**

Run:

```bash
npx tsx --test packages/agent/test/interview/diagnose-transcript-skill.test.ts
```

Expected: FAIL because the new Skill interfaces and implementation do not exist.

- [ ] **Step 3: Replace the obsolete Skill contract**

删除旧通用 `SkillContext`，不再把不存在的 Session、Hooks 或KnowledgeBase塞入类型。`diagnose-transcript.ts` 导出上面的明确业务接口和工厂。

依赖接口固定为：

```ts
export interface DiagnoseTranscriptDependencies {
    model: string;
    readFileTool: Tool<ReadFileInput, ReadFileOutput>;
    writeFileTool: Tool<WriteFileInput, WriteFileOutput>;
    preprocessTool: Tool<PreprocessTranscriptInput, PreprocessTranscriptOutput>;
    extractProjectFactsTool: Tool<ExtractProjectFactsInput, ProjectFactSet>;
    analyzeExpressionTool: Tool<AnalyzeExpressionInput, ExpressionAnalysis>;
    analyzeAnswerTool: Tool<AnalyzeAnswerInput, CompletedQuestionAnalysis | NotScoredQuestionAnalysis>;
    generateReportTool: Tool<GenerateReportInput, GenerateReportOutput>;
    structure: typeof structureInterview;
    referenceRetriever?: InterviewReferenceRetriever;
    now: () => Date;
}
```

需要从现有原子 Tool 文件导出缺失的Input/Output类型；只改 `export`，不改变行为。

- [ ] **Step 4: Implement the fixed SOP**

实现顺序必须对应设计文档。关键组装：

```ts
const transcriptText = await readWholeText(
    dependencies.readFileTool,
    input.transcriptPath,
    context,
);
const transcript = parseTranscript(transcriptText.content);
const preprocessed = await requireToolData(
    dependencies.preprocessTool.execute({ transcript }, context),
);
const structuredParts = await dependencies.structure({
    transcript,
    correctedTurns: preprocessed.correctedTurns,
    queryEngine: context.queryEngine,
    model: dependencies.model,
    abortSignal: context.abortSignal,
});
const structuredInterview: StructuredInterview = {
    transcript,
    corrections: preprocessed.corrections,
    ...structuredParts,
};
```

项目事实只对含 `questionType === "project"` 的问题簇提取。失败时不创建伪造事实集合。

逐题循环必须按 `structuredInterview.questions` 顺序：

```ts
for (const question of structuredInterview.questions) {
    const cluster = clusterById.get(question.clusterId)!;
    const clusterQuestions = questionsByCluster.get(cluster.id)!;
    if (question.questionType === "procedural") {
        analyses.push({
            status: "not_scored",
            questionId: question.id,
            clusterId: question.clusterId,
        });
        continue;
    }

    const expressionResult = await dependencies.analyzeExpressionTool.execute({
        questionId: question.id,
        answer: question.originalAnswer,
    }, context);
    const expression = expressionResult.success
        ? expressionResult.data!
        : failedExpression(question.id, question.originalAnswer);

    let references: string[] = [];
    if (question.questionType === "knowledge" && dependencies.referenceRetriever) {
        try {
            references = await dependencies.referenceRetriever.retrieve(
                question.originalQuestion,
                context.abortSignal,
            );
        } catch {
            references = [];
        }
    }

    const answerResult = await dependencies.analyzeAnswerTool.execute({
        question,
        cluster,
        clusterQuestions,
        projectFacts: projectFactsByCluster.get(cluster.id) ?? null,
        expression,
        references,
    }, context);
    analyses.push(answerResult.success
        ? answerResult.data!
        : {
            status: "failed",
            questionId: question.id,
            clusterId: question.clusterId,
            error: answerResult.error?.message ?? "逐题分析失败",
        });
}
```

报告输入固定 `stage: "provisional"`。提供 `jdPath` 时先完整读取；`jdText`与`jdPath`同时出现返回 `input_error`。

报告写入成功后构造精简输出：

```ts
return {
    success: true,
    data: {
        reportPath,
        levelSummary: report.summaryStatus === "completed"
            ? report.levelSummary
            : "汇总失败；请查看逐题分析。",
        totalScore: report.score.totalScore,
        analyzedCount: report.score.coverage.analyzed,
        questionCount: report.questions.length,
        pendingClarifications: report.pendingClarifications,
        jobMatchSummary: report.jobMatchStatus === "completed"
            ? report.jobMatch!.summary
            : null,
    },
};
```

- [ ] **Step 5: Run Skill focused tests**

Run:

```bash
npx tsx --test packages/agent/test/interview/diagnose-transcript-skill.test.ts packages/agent/test/interview/interview-file-io.test.ts
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
git diff --check
```

Expected: Skill和面试域测试PASS；面试类型检查PASS。

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/agent/src/skills/diagnose-transcript.ts packages/agent/src/skills/interview-reference-retriever.ts packages/agent/src/tools/tool-item/preprocess-transcript.ts packages/agent/src/tools/tool-item/extract-project-facts.ts packages/agent/src/tools/tool-item/analyze-expression.ts packages/agent/src/tools/tool-item/analyze-answer.ts packages/agent/src/tools/tool-item/generate-report.ts packages/agent/test/interview/diagnose-transcript-skill.test.ts packages/agent/tsconfig.interview.json
git rm packages/agent/src/skills/types.ts
git commit -m "feat: orchestrate provisional interview analysis"
```

提交前检查暂存区，确保 `packages/agent/src/tools/tool-item` 只包含为导出Input/Output类型所需的小改动，不能意外暂存其他文件。

---

### Task 4: Business Tool, Public Registry, and Optional Knowledge Adapter

**Files:**

- Create: `packages/agent/src/tools/tool-item/analyze-interview.ts`
- Modify: `packages/agent/src/tools/index.ts`
- Modify: `packages/agent/src/config.ts`
- Modify: `packages/agent/src/knowledge/index.ts`
- Modify: `packages/agent/src/skills/interview-reference-retriever.ts`
- Modify: `packages/agent/src/cli/run.ts`
- Modify: `packages/agent/test/tools/filesystem-tools.test.ts`
- Modify: `packages/agent/test/phase1/agent-loop.test.ts`
- Create: `packages/agent/test/interview/analyze-interview.test.ts`
- Delete: old interview Tool files listed in File Map

**Interfaces:**

```ts
export interface CreateToolRegistryOptions {
    cwd?: string;
    model: string;
    referenceRetriever?: InterviewReferenceRetriever;
    now?: () => Date;
}

export function createToolRegistry(
    options: CreateToolRegistryOptions,
): ToolRegistry;

export function createAnalyzeInterviewTool(
    skill: DiagnoseTranscriptSkill,
): Tool<DiagnoseTranscriptInput, DiagnoseTranscriptOutput>;
```

- [ ] **Step 1: Write failing business Tool validation tests**

在 `analyze-interview.test.ts` 增加：

```ts
test("analyze_interview 拒绝相对文字稿路径", async () => {
    const tool = createAnalyzeInterviewTool(fakeSkill());
    const result = await tool.execute({ transcriptPath: "notes/interview.md" }, context());
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

test("analyze_interview 拒绝同时提供jdText和jdPath", async () => {
    const tool = createAnalyzeInterviewTool(fakeSkill());
    const result = await tool.execute({
        transcriptPath: "/tmp/interview.md",
        jdText: "JD",
        jdPath: "/tmp/jd.md",
    }, context());
    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

test("analyze_interview 只转发规范化输入并返回Skill结果", async () => {
    const calls: DiagnoseTranscriptInput[] = [];
    const tool = createAnalyzeInterviewTool(fakeSkill(calls));
    const result = await tool.execute({
        transcriptPath: "/tmp/interview.md",
        metadata: { company: " 字节跳动 " },
    }, context());
    assert.equal(result.success, true);
    assert.equal(calls[0]?.metadata?.company, "字节跳动");
});
```

- [ ] **Step 2: Verify business Tool tests fail**

Run:

```bash
npx tsx --test packages/agent/test/interview/analyze-interview.test.ts
```

Expected: FAIL because `analyze-interview.ts` does not exist.

- [ ] **Step 3: Implement strict business input validation**

Tool Schema必须：

```ts
{
    type: "object",
    properties: {
        transcriptPath: { type: "string" },
        metadata: {
            type: "object",
            properties: {
                company: { type: "string" },
                position: { type: "string" },
                date: { type: "string" },
                round: { type: "string" },
            },
            additionalProperties: false,
        },
        jdText: { type: "string" },
        jdPath: { type: "string" },
    },
    required: ["transcriptPath"],
    additionalProperties: false,
}
```

代码验证 `isAbsolute(transcriptPath)`、可选 `jdPath` 绝对路径、JD二选一、所有文本trim后非空。业务 Tool不自行找文件；找文件和确认属于Agent对话阶段。

- [ ] **Step 4: Implement the FTS-only reference adapter**

在 `interview-reference-retriever.ts` 增加：

```ts
export function createFtsInterviewReferenceRetriever(
    search: KnowledgeSearch,
): InterviewReferenceRetriever {
    return {
        async retrieve(question, abortSignal) {
            if (abortSignal.aborted) throw new Error("面试分析已中止");
            const results = await search.search({
                query: question,
                method: "fts",
                limit: 3,
            });
            if (abortSignal.aborted) throw new Error("面试分析已中止");
            return results.map(({ entry }) => [
                `参考问题：${entry.question}`,
                `参考答案：${entry.expertAnswer}`,
                `来源：${entry.sourceFile}`,
            ].join("\n"));
        },
    };
}
```

增加单测：FTS结果正确映射；AbortSignal已中止时不查询。

- [ ] **Step 5: Replace the public Registry**

`createToolRegistry(options)` 创建一次read/write Tool，同时把相同实例注入Skill：

```ts
const readFileTool = createReadFileTool(cwd);
const writeFileTool = createWriteFileTool(cwd);
const skill = createDiagnoseTranscriptSkill({
    model: options.model,
    readFileTool,
    writeFileTool,
    preprocessTool: createPreprocessTranscriptTool(options.model),
    extractProjectFactsTool: createExtractProjectFactsTool(options.model),
    analyzeExpressionTool: createAnalyzeExpressionTool(options.model),
    analyzeAnswerTool: createAnalyzeAnswerTool(options.model),
    generateReportTool: createGenerateReportTool(options.model),
    structure: structureInterview,
    referenceRetriever: options.referenceRetriever,
    now: options.now ?? (() => new Date()),
});

registry.register(readFileTool);
registry.register(createFindFilesTool(cwd));
registry.register(createGrepFilesTool(cwd));
registry.register(writeFileTool);
registry.register(createAnalyzeInterviewTool(skill));
```

Registry列表固定为：

```ts
["read_file", "find_files", "grep_files", "write_file", "analyze_interview"]
```

不注册 `split_qa_pairs` 或任何内部分析 Tool。

- [ ] **Step 6: Retire the old incomplete interview flow**

先执行：

```bash
rg -n "split_qa_pairs|analyze_content|analyze_speech|query_knowledge_base" packages/agent/src packages/agent/test
```

确认唯一运行时引用已由新Skill替代后，删除File Map列出的四个旧 Tool 文件和只验证旧 `split_qa_pairs` 的 `phase1/split.test.ts`。把 `agent-loop.test.ts` 中“Tool Call结果回传模型”的通用协议测试改用一个测试专用 `analyze_interview` Stub，不能删除这条AgentLoop协议覆盖。不得删除现有KnowledgeSearch、Repository或本阶段复用的原子分析文件。

- [ ] **Step 7: Wire optional knowledge retrieval into CLI lifecycle**

`AgentConfig` 增加可选 `knowledgeDatabasePath`，仅当 `KNOWLEDGE_DATABASE_PATH` 非空时返回。

CLI规则：

```ts
let knowledgeDatabase: Database.Database | undefined;
let referenceRetriever: InterviewReferenceRetriever | undefined;
if (
    config.knowledgeDatabasePath
    && existsSync(config.knowledgeDatabasePath)
) {
    knowledgeDatabase = openKnowledgeDatabase(config.knowledgeDatabasePath);
    const repository = new KnowledgeRepository(knowledgeDatabase);
    referenceRetriever = createFtsInterviewReferenceRetriever(
        new KnowledgeSearch(repository),
    );
}

const toolRegistry = createToolRegistry({
    model: config.model,
    referenceRetriever,
});
```

`finally`中关闭可选knowledgeDatabase，关闭失败遵循现有Memory/Session聚合错误方式。路径未配置或不存在时不创建空数据库，Skill得到空引用并使用既有置信度上限。

- [ ] **Step 8: Run Registry, knowledge and typecheck verification**

Run:

```bash
npx tsx --test packages/agent/test/interview/analyze-interview.test.ts packages/agent/test/tools/filesystem-tools.test.ts
npm run test:knowledge -w @dkagent/agent
npm run test:interview -w @dkagent/agent
npm run typecheck -w @dkagent/agent
git diff --check
```

Expected: 所有命令PASS；旧Skill/Tool导致的19个全包typecheck错误归零。

- [ ] **Step 9: Commit Task 4**

```bash
git add packages/agent/src/tools/tool-item/analyze-interview.ts packages/agent/src/tools/index.ts packages/agent/src/config.ts packages/agent/src/knowledge/index.ts packages/agent/src/skills/interview-reference-retriever.ts packages/agent/src/cli/run.ts packages/agent/test/interview/analyze-interview.test.ts packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/phase1/agent-loop.test.ts
git rm packages/agent/src/tools/tool-item/split.ts packages/agent/src/tools/tool-item/analyze_content.ts packages/agent/src/tools/tool-item/analyze_speech.ts packages/agent/src/tools/tool-item/knowledge-base.ts packages/agent/test/phase1/split.test.ts
git commit -m "feat: expose interview analysis business tool"
```

---

### Task 5: Agent File Discovery and Confirmation Contract

**Files:**

- Modify: `packages/agent/src/agent/prompt.ts`
- Modify: `packages/agent/test/phase1/agent-loop.test.ts`
- Create: `packages/agent/test/phase1/interview-agent-routing.test.ts`

**Interfaces:**

- Agent仍使用现有 `AgentLoop`、原生Tool Calling和对话历史。
- 不新增关键词分类器、命令路由或Agent状态机。

- [ ] **Step 1: Replace the obsolete Prompt test with failing new assertions**

把旧断言：

```ts
assert.match(AGENT_SYSTEM_PROMPT, /同一条消息.*文件路径/);
```

替换为：

```ts
assert.match(AGENT_SYSTEM_PROMPT, /文件名.*关键词.*大致目录/);
assert.match(AGENT_SYSTEM_PROMPT, /没有.*目录.*询问/);
assert.match(AGENT_SYSTEM_PROMPT, /不得.*整个用户目录/);
assert.match(AGENT_SYSTEM_PROMPT, /0.*补充.*目录.*关键词/);
assert.match(AGENT_SYSTEM_PROMPT, /多个.*最多.*5/);
assert.match(AGENT_SYSTEM_PROMPT, /展示.*绝对路径.*确认/);
assert.match(AGENT_SYSTEM_PROMPT, /未确认.*不得调用.*analyze_interview/);
assert.match(AGENT_SYSTEM_PROMPT, /公司.*岗位.*日期.*轮次/);
assert.match(AGENT_SYSTEM_PROMPT, /JD/);
assert.match(AGENT_SYSTEM_PROMPT, /不得.*编造.*路径/);
```

- [ ] **Step 2: Verify the Prompt test fails for the intended reason**

Run:

```bash
npm run test:phase1 -w @dkagent/agent
```

Expected: 只失败于新的路径发现/确认断言；旧 `/同一条消息.*文件路径/` 失败不再存在。

- [ ] **Step 3: Write a multi-turn AgentLoop wiring test**

在 `interview-agent-routing.test.ts` 使用脚本FakeProvider和真实临时目录验证两次 `agent.run()`：

第一轮Provider响应：

```ts
toolCallResponse("find-1", "find_files", {
    path: tempRoot,
    pattern: "**/*字节*1面*.md",
    limit: 5,
})
```

第二个模型响应返回文本：

```text
找到：<绝对路径>。请确认这是要分析的文字稿，并确认公司、岗位、日期、轮次；是否提供JD？
```

断言第一轮没有执行 `analyze_interview`。

用户第二轮输入确认并跳过JD后，Provider返回：

```ts
toolCallResponse("analysis-1", "analyze_interview", {
    transcriptPath: absoluteTranscriptPath,
    metadata: {
        company: "字节跳动",
        position: "前端工程师",
        date: "2026-08-04",
        round: "一面",
    },
})
```

最终Provider文本必须包含暂定分、覆盖率、待确认项和报告路径。Stub业务 Tool记录调用次数，断言只在第二轮执行一次。

同文件再增加两个短用例：`find_files`返回空数组后Provider只询问补充目录或关键词；返回6个结果后Provider最多展示5个并等待用户选择。两者都断言 `analyze_interview` 调用次数为0。

- [ ] **Step 4: Verify routing test fails before Prompt update**

Run:

```bash
npx tsx --test packages/agent/test/phase1/interview-agent-routing.test.ts
```

Expected: 初始FAIL，因为测试辅助响应或新Registry契约尚未在测试中接好；不得通过硬编码业务意图到AgentLoop修复。

- [ ] **Step 5: Update the System Prompt only**

Prompt明确以下正向规则：

```text
普通聊天直接回答，不调用工具。
用户要求分析面试时，可以接收完整路径，也可以接收文件名、关键词和大致目录。
只有文件名或关键词但没有搜索目录时，先询问大致目录；不得扫描整个用户目录。
有目录后使用find_files，0个结果请用户补充，1个结果或多个结果都必须展示组合后的绝对路径并等待用户确认。
未确认文字稿实际路径前不得调用analyze_interview，不得猜测、编造或替用户选择路径。
确认路径时同时确认公司、岗位、日期、轮次；未知字段写未提供，并询问是否提供JD。
用户确认输入后调用analyze_interview；不要直接调用或要求调用内部分析步骤。
```

不要添加 `/diagnose`、关键词if/else或Shell路由。

- [ ] **Step 6: Run Agent regression**

Run:

```bash
npx tsx --test packages/agent/test/phase1/interview-agent-routing.test.ts
npm run test:phase1 -w @dkagent/agent
npm test -w @dkagent/agent
npm run typecheck -w @dkagent/agent
git diff --check
```

Expected: Phase1由16/17恢复全绿；Agent全量测试全绿；typecheck全绿。

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/agent/src/agent/prompt.ts packages/agent/test/phase1/agent-loop.test.ts packages/agent/test/phase1/interview-agent-routing.test.ts
git commit -m "feat: guide users through interview file confirmation"
```

---

### Task 6: End-to-end Business Tool Verification and Status Documentation

**Files:**

- Modify: `packages/agent/test/interview/analyze-interview.test.ts`
- Modify: `desginDocs/02-sop-agent-nodes.md`
- Modify: `desginDocs/index.md`

**Interfaces:**

- Exercises the real `createToolRegistry()` → `analyze_interview` → Skill → atomic Tool chain.
- Uses a scripted FakeProvider; no real model, Session or Memory.

- [ ] **Step 1: Add a failing real-chain integration test**

创建包含项目题、知识题和流程题的临时文字稿。文字稿总行数至少501行，最后一个问题位于第500行之后。使用固定 `now()`。

Scripted FakeProvider按实际模型调用顺序返回：

1. `preprocess_transcript`：`{"corrections":[]}`。
2. `structureInterview`：三个问题、三个问题簇和完整answerTurnIds。
3. `extract_project_facts`：带逐字quote的项目事实。
4. 项目题 `analyze_expression`。
5. 项目题 `analyze_answer`。
6. 知识题 `analyze_expression`。
7. 知识题 `analyze_answer`。
8. 通用报告summary。
9. JD岗位匹配。

流程题不得消费模型响应。

调用：

```ts
const registry = createToolRegistry({
    cwd: tempRoot,
    model: "fake-model",
    referenceRetriever: {
        async retrieve() {
            return ["参考答案：事件循环按阶段执行任务。"];
        },
    },
    now: () => new Date("2026-08-18T10:20:30+08:00"),
});
const result = await registry.resolve("analyze_interview").execute({
    transcriptPath,
    metadata: {
        company: "字节跳动",
        position: "前端工程师",
        date: "2026-08-04",
        round: "一面",
    },
    jdText: "负责复杂前端系统建设，理解JavaScript事件循环。",
}, contextFor(scriptedProvider));
```

断言：

```ts
assert.equal(result.success, true);
assert.equal(result.data?.questionCount, 3);
assert.equal(result.data?.analyzedCount, 2);
assert.ok(result.data?.reportPath.endsWith("-面试分析-20260818-102030.md"));
assert.equal("markdown" in result.data!, false);
assert.equal("questions" in result.data!, false);
const markdown = await readFile(result.data!.reportPath, "utf8");
assert.match(markdown, /字节跳动/);
assert.match(markdown, /岗位匹配/);
assert.match(markdown, /最后一个流程问题的原文/);
assert.match(markdown, /分数：不参与评分/);
assert.equal(scriptedProvider.remainingResponses, 0);
assert.equal(existsSync(join(tempRoot, ".dkagent", "memory.db")), false);
assert.equal(existsSync(join(tempRoot, ".dkagent", "sessions.db")), false);
```

- [ ] **Step 2: Verify the integration test fails before final wiring fixes**

Run:

```bash
npx tsx --test packages/agent/test/interview/analyze-interview.test.ts
```

Expected: 新的真实链路用例FAIL；记录具体失败，不跳过组件来伪造通过。

- [ ] **Step 3: Make only the minimal integration fixes**

允许修复：

- 新文件未纳入tsconfig。
- 实际模型调用顺序与测试脚本不一致。
- 长文件分页拼接边界。
- Registry向Skill传递相同Tool实例、model、referenceRetriever或now。
- 业务Tool结果意外包含完整报告。

不允许新增Session任务状态、Memory写入、并行执行、上传接口或最终报告。

- [ ] **Step 4: Update implementation status docs**

`desginDocs/02-sop-agent-nodes.md` 当前状态改为：

```md
- 已实现：Agent文件查找与路径确认约束、`analyze_interview`业务Tool、`diagnose-transcript` Skill顺序编排、可选JD岗位匹配、暂定报告落盘。
- 已验证：FakeProvider完整链路覆盖长文件、项目题、知识题、流程题、单题降级、JD证据和报告不覆盖。
- 尚未接入：用户事实确认后的局部重跑、最终报告、诊断Session暂停恢复、Memory时间线和文件上传。
```

`desginDocs/index.md` 删除“诊断Skill、长稿结构化和最终报告均待实现”的过时表述，明确暂定分析已接入、最终阶段仍未实现。

- [ ] **Step 5: Run final feature verification**

Run:

```bash
npm run test:interview -w @dkagent/agent
npm run test:phase1 -w @dkagent/agent
npm run test:knowledge -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
npm run typecheck -w @dkagent/agent
npm test -w @dkagent/agent
git diff --check
git status --short
```

Expected: 所有测试和类型检查全绿，`git diff --check`无输出；工作树只包含本Task待提交的测试和文档。

- [ ] **Step 6: Confirm runtime boundaries**

Run:

```bash
git diff HEAD~5..HEAD -- packages/agent/src/session packages/agent/src/memory
rg -n "write|upsert|append" packages/agent/src/skills/diagnose-transcript.ts
```

Expected: Session和Memory无业务接入改动；Skill的写入只指向Markdown报告文件。

- [ ] **Step 7: Commit Task 6**

```bash
git add packages/agent/test/interview/analyze-interview.test.ts desginDocs/02-sop-agent-nodes.md desginDocs/index.md
git commit -m "test: verify interview agent business flow"
```

---

## Final Review Checklist

- [ ] `analyze_interview` 是Agent唯一可见的面试业务Tool。
- [ ] 用户可以用目录和关键词查找文件，但未确认路径时不会启动分析。
- [ ] Skill固定顺序编排，内部分析Tool未公开注册。
- [ ] 超过500行的文字稿完整读取，最后问题仍在报告中。
- [ ] 单题失败、知识库失败和JD匹配失败按设计降级。
- [ ] JD引用逐字证据，且不改变总分。
- [ ] Tool Result不包含完整Markdown或完整问题列表。
- [ ] 报告排他写入，不覆盖原稿和已有报告。
- [ ] 暂定分析不写Session诊断状态或Memory。
- [ ] 旧未完成面试链已移除，全包typecheck恢复全绿。
- [ ] Phase1旧Prompt基线失败已由新行为契约替换并通过。
- [ ] 不存在真实模型、真实Embedding或用户私人文字稿依赖的自动化测试。
