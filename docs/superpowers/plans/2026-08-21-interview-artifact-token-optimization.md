# Interview Artifact Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep large interview inputs and intermediate JSON in session-scoped memory while the Agent passes only Artifact IDs and small summaries between the existing interview tools.

**Architecture:** Add a typed `InMemoryArtifactStore`, inject one Store per active Session through `AgentLoop`, and migrate the minimal interview Tool chain to ID-based inputs. The Store emits metadata-only Trace events; Web Tap renders those events with Chinese labels. The final report remains a full user-facing output.

**Tech Stack:** TypeScript 7, Node.js, `node:test`, Zod, existing `@dkagent/trace`, React/Ant Design Web Tap.

## Global Constraints

- Keep `read_file -> parse_transcript -> structure_interview -> analyze_answer -> generate_report`.
- Store Artifacts only in current-process memory and isolate them by Session.
- Process restart invalidates Artifact IDs; do not add persistence, TTL, eviction, retrieval, or document windowing.
- Do not expose Artifact values, transcript text, or full intermediate JSON in Tool Results or Trace.
- Preserve ordinary inline `read_file`; Artifact mode reads the complete file and rejects `offset`/`limit`.
- Keep domain functions callable directly; only Tool contracts become Artifact-based.
- Keep `generate_report` returning the full report and Markdown.
- The worktree is dirty. Stage only task-owned hunks; inspect `git diff --cached` before every commit.

## File Map

- Create `packages/agent/src/artifact/{types,store,index}.ts`: Artifact port and implementation.
- Create `packages/agent/test/artifact/store.test.ts`: Store and redaction coverage.
- Modify `packages/trace/src/types.ts`: Artifact Trace names/module.
- Modify AgentLoop, CLI, and Tool context files: Session Store injection.
- Modify five minimal-chain Tools and Skill: reference-only data flow.
- Modify Web Tap model/presentation: Chinese Artifact nodes.
- Create `packages/agent/test/interview/artifact-flow.integration.test.ts`: whole-chain boundary test.

---

### Task 1: Artifact Store and Trace Contract

**Files:**
- Create: `packages/agent/src/artifact/types.ts`
- Create: `packages/agent/src/artifact/store.ts`
- Create: `packages/agent/src/artifact/index.ts`
- Create: `packages/agent/test/artifact/store.test.ts`
- Modify: `packages/trace/src/types.ts`
- Modify: `packages/trace/test/tracer-session.test.ts`

**Interfaces:**
- Produces `ArtifactKind`, `ArtifactMetadata`, `ArtifactStore`, `ArtifactAccessError`, `InMemoryArtifactStore`.
- Produces `artifact.created`, `artifact.resolved`, and Trace module `artifact`.

- [ ] **Step 1: Write failing tests**

```ts
test("Artifact Store 按类型读写且 Trace 不包含正文", () => {
    const traceStore = new MemoryTraceStore();
    const artifacts = new InMemoryArtifactStore(new Tracer(traceStore));
    const secret = "完整面试原文不得进入 Trace";
    const id = artifacts.put("file_text", secret, {
        producer: "read_file",
        characterCount: secret.length,
        itemCount: 1,
        exposedCharacterCount: 120,
    });

    assert.equal(artifacts.get(id, "file_text", "parse_transcript"), secret);
    const events = traceStore.list().filter((event) => event.name.startsWith("artifact."));
    assert.deepEqual(events.map((event) => event.name), [
        "artifact.created",
        "artifact.resolved",
    ]);
    assert.doesNotMatch(JSON.stringify(events), /完整面试原文/);
});

test("Artifact Store 拒绝未知 ID 和错误类型", () => {
    const artifacts = new InMemoryArtifactStore();
    const id = artifacts.put("file_text", "text", { producer: "read_file" });
    assert.throws(
        () => artifacts.get(id, "parsed_transcript", "structure_interview"),
        /Artifact 类型不匹配/,
    );
    assert.throws(
        () => artifacts.get("missing", "file_text", "parse_transcript"),
        /Artifact 不存在或已过期/,
    );
});
```

Extend the Trace public type test:

```ts
const module: TraceModule = "artifact";
const names: TraceEventName[] = ["artifact.created", "artifact.resolved"];
assert.equal(module, "artifact");
assert.equal(names.length, 2);
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test packages/agent/test/artifact/store.test.ts packages/trace/test/tracer-session.test.ts
```

Expected: FAIL because Artifact files and Trace members do not exist.

- [ ] **Step 3: Implement minimal contracts**

```ts
export type ArtifactKind =
    | "file_text"
    | "parsed_transcript"
    | "structured_interview"
    | "question_analysis";

export interface ArtifactMetadata {
    producer: string;
    characterCount?: number;
    itemCount?: number;
    exposedCharacterCount?: number;
}

export interface ArtifactStore {
    put<T>(kind: ArtifactKind, value: T, metadata: ArtifactMetadata): string;
    get<T>(id: string, expectedKind: ArtifactKind, consumer: string): T;
}

export class ArtifactAccessError extends Error {}
```

Implement the Store with `randomUUID()` and a private `Map`. Emit only IDs and metadata:

```ts
this.tracer?.event("artifact.created", {
    artifactId: id,
    artifactType: kind,
    ...metadata,
    omittedCharacterCount: Math.max(
        0,
        (metadata.characterCount ?? 0) - (metadata.exposedCharacterCount ?? 0),
    ),
}, { module: "artifact", operation: metadata.producer });
```

Every `get` emits `artifact.resolved` with ID, expected type, consumer, and `hit`; never include `value`.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --test packages/agent/test/artifact/store.test.ts packages/trace/test/tracer-session.test.ts
npm run typecheck --workspace @dkagent/trace
npm run typecheck --workspace @dkagent/agent
```

Expected: all exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/agent/src/artifact packages/agent/test/artifact packages/trace/src/types.ts packages/trace/test/tracer-session.test.ts
git diff --cached --check
git commit -m "feat(agent): add session artifact store"
```

---

### Task 2: Session Ownership and Tool Injection

**Files:**
- Modify: `packages/agent/src/tools/types.ts`
- Modify: `packages/agent/src/agent/types.ts`
- Modify: `packages/agent/src/agent/loop.ts`
- Modify: `packages/agent/src/cli/run.ts`
- Modify: `packages/agent/test/phase1/agent-loop.test.ts`
- Modify: `packages/agent/test/session/cli-session.test.mjs`

**Interfaces:**
- Consumes Task 1 Store.
- Produces `ToolContext.artifactStore` and `AgentLoopOptions.artifactStore`.

- [ ] **Step 1: Write failing injection test**

```ts
let receivedStore: ArtifactStore | undefined;
registry.register({
    name: "capture_store",
    description: "capture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, ctx) {
        receivedStore = ctx.artifactStore;
        return { success: true, data: { captured: true } };
    },
});
await agent.run("run");
assert.ok(receivedStore);
```

Add a CLI regression using an injectable Store factory: `/new` gets a different Store and `/switch` reuses the Store mapped to that Session.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test packages/agent/test/phase1/agent-loop.test.ts
node --test packages/agent/test/session/cli-session.test.mjs
```

Expected: FAIL because AgentLoop does not inject a Store.

- [ ] **Step 3: Implement ownership**

```ts
export interface ToolContext {
    queryEngine: QueryEngine;
    abortSignal: AbortSignal;
    tracer?: Tracer;
    artifactStore?: ArtifactStore;
}

export interface AgentLoopOptions {
    // existing fields remain
    artifactStore?: ArtifactStore;
}
```

AgentLoop owns a fallback Store and passes it to `dispatchToolCall`:

```ts
this.artifactStore = options.artifactStore
    ?? new InMemoryArtifactStore(this.tracer);
```

CLI maintains `Map<string, ArtifactStore>`, injects `getOrCreateArtifactStore(snapshot.id)`, and deletes the mapping after `/delete`. Restart starts with an empty map.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --test packages/agent/test/phase1/agent-loop.test.ts
node --test packages/agent/test/session/cli-session.test.mjs
npm run typecheck --workspace @dkagent/agent
```

Expected: all exit 0.

- [ ] **Step 5: Commit Task 2 hunks only**

```bash
git add -p packages/agent/src/tools/types.ts packages/agent/src/agent/types.ts packages/agent/src/agent/loop.ts packages/agent/src/cli/run.ts packages/agent/test/phase1/agent-loop.test.ts packages/agent/test/session/cli-session.test.mjs
git diff --cached --check
git commit -m "feat(agent): scope artifacts to sessions"
```

---

### Task 3: File and Transcript Artifact Tools

**Files:**
- Modify: `packages/agent/src/tools/filesystem/read-file.ts`
- Modify: `packages/agent/src/tools/tool-item/parse-transcript.ts`
- Modify: `packages/agent/test/tools/filesystem-tools.test.ts`
- Modify: `packages/agent/test/interview/skill-exposure.test.ts`

**Interfaces:**
- `read_file({ path, storeAsArtifact: true }) -> { path, artifactId, characterCount, totalLines }`.
- `parse_transcript({ sourceArtifactId }) -> { artifactId, turnCount }`.

- [ ] **Step 1: Write failing Tool tests**

```ts
const result = await createReadFileTool(cwd).execute(
    { path: "interview.md", storeAsArtifact: true },
    context,
);
assert.equal(result.success, true);
assert.equal("content" in (result.data ?? {}), false);
assert.equal(result.data?.characterCount, source.length);
assert.equal(
    artifacts.get(result.data!.artifactId, "file_text", "test"),
    source,
);
```

Assert Artifact mode plus `offset` or `limit` returns `input_error`. Test parsing:

```ts
const sourceArtifactId = artifacts.put("file_text", source, { producer: "test" });
const parsed = await parseTool.execute({ sourceArtifactId }, context);
assert.equal(parsed.data?.turnCount, 2);
const transcript = artifacts.get<ParsedTranscript>(
    parsed.data!.artifactId,
    "parsed_transcript",
    "test",
);
assert.equal(transcript.turns.length, 2);
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/interview/skill-exposure.test.ts
```

Expected: FAIL because Tools still expose full content.

- [ ] **Step 3: Implement minimal Tool contracts**

Add `storeAsArtifact?: boolean` to `ReadFileInput`. Artifact mode reads the complete file, writes `file_text`, returns no content, and requires `ctx.artifactStore`.

```ts
export interface ParseTranscriptInput {
    sourceArtifactId: string;
}

export interface ParseTranscriptOutput {
    artifactId: string;
    turnCount: number;
}
```

Convert missing Store, missing ID, and wrong type to `input_error`. Parsing errors remain `input_error`.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --test packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/interview/skill-exposure.test.ts
npm run typecheck --workspace @dkagent/agent
```

Expected: all exit 0.

- [ ] **Step 5: Commit Task 3 hunks only**

```bash
git add -p packages/agent/src/tools/filesystem/read-file.ts packages/agent/src/tools/tool-item/parse-transcript.ts packages/agent/test/tools/filesystem-tools.test.ts packages/agent/test/interview/skill-exposure.test.ts
git diff --cached --check
git commit -m "feat(agent): pass transcript files by artifact"
```

---

### Task 4: Structure and Analyze by Artifact ID

**Files:**
- Modify: `packages/agent/src/tools/tool-item/structure-interview.ts`
- Modify: `packages/agent/src/tools/tool-item/analyze-answer.ts`
- Modify: `packages/agent/test/interview/skill-exposure.test.ts`
- Modify: `packages/agent/test/interview/analyze-answer.test.ts`

**Interfaces:**
- `structure_interview({ transcriptArtifactId }) -> { artifactId, clusterCount, questionIds }`.
- `analyze_answer({ structuredInterviewArtifactId, questionId }) -> { artifactId, questionId, clusterId, status, score? }`.

- [ ] **Step 1: Write failing structure chain test**

```ts
const structured = await registry.resolve("structure_interview").execute({
    transcriptArtifactId: parsed.data!.artifactId,
}, context);
assert.deepEqual(structured.data?.questionIds, ["question-0001"]);
assert.equal("questions" in (structured.data ?? {}), false);
const stored = artifacts.get<StructuredInterview>(
    structured.data!.artifactId,
    "structured_interview",
    "test",
);
assert.equal(stored.questions.length, 1);
```

Migrate the analyze test helper to store a `StructuredInterview`, invoke with its ID and `questionId`, resolve the returned `question_analysis`, then run existing assertions. Add a regression that the Tool Result omits `originalAnswer`, strengths, issues, and improvements.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test packages/agent/test/interview/skill-exposure.test.ts packages/agent/test/interview/analyze-answer.test.ts
```

Expected: FAIL because structure/analyze still accept full objects.

- [ ] **Step 3: Implement structure flow**

```ts
export interface StructureInterviewOutput {
    artifactId: string;
    clusterCount: number;
    questionIds: string[];
}
```

Resolve `parsed_transcript`, call existing `structureInterview`, combine `{ transcript, ...output }` into `StructuredInterview`, store it, and return the summary.

- [ ] **Step 4: Implement analysis flow**

```ts
export interface AnalyzeAnswerInput {
    structuredInterviewArtifactId: string;
    questionId: string;
}

export interface AnalyzeAnswerOutput {
    artifactId: string;
    questionId: string;
    clusterId: string;
    status: QuestionAnalysis["status"];
    score?: number;
}
```

Resolve the interview, locate question/cluster/clusterQuestions, execute existing one-LLM logic, store complete `QuestionAnalysis`, and return only the summary. Unknown question and Artifact failures return `input_error`.

If the model, JSON Schema, evidence, or scoring step fails after valid input resolution, store this value and return `success: true` with `status: "failed"` so report generation can continue:

```ts
const failed: FailedQuestionAnalysis = {
    status: "failed",
    questionId: question.id,
    clusterId: question.clusterId,
    error: error instanceof Error ? error.message : "回答分析失败",
};
```

The returned summary includes the failed Artifact ID and omits `score`.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --test packages/agent/test/interview/skill-exposure.test.ts packages/agent/test/interview/analyze-answer.test.ts
npm run typecheck --workspace @dkagent/agent
```

Expected: all exit 0 and one-LLM-call assertions remain true.

- [ ] **Step 6: Commit Task 4 hunks only**

```bash
git add -p packages/agent/src/tools/tool-item/structure-interview.ts packages/agent/src/tools/tool-item/analyze-answer.ts packages/agent/test/interview/skill-exposure.test.ts packages/agent/test/interview/analyze-answer.test.ts
git diff --cached --check
git commit -m "feat(agent): analyze interview artifacts by id"
```

---

### Task 5: Report Resolution and Skill Workflow

**Files:**
- Modify: `packages/agent/src/tools/tool-item/generate-report.ts`
- Modify: `packages/agent/test/interview/generate-report.test.ts`
- Modify: `packages/agent/skills/diagnose-transcript/SKILL.md`
- Modify: `packages/agent/test/interview/skill-exposure.test.ts`

**Interfaces:**
- `generate_report({ structuredInterviewArtifactId, analysisArtifactIds, stage, metadata? })`.
- Produces existing full `GenerateReportOutput`.

- [ ] **Step 1: Write failing report and Skill tests**

Store the fixture interview and analyses, then invoke:

```ts
const result = await tool.execute({
    structuredInterviewArtifactId,
    analysisArtifactIds,
    stage: "provisional",
}, context);
assert.equal(result.success, true);
assert.equal(result.data?.report.score.coverage.analyzed, 2);
assert.match(result.data?.markdown ?? "", /面试分析报告/);
```

Add failures for missing ID, wrong kind, duplicate analysis IDs, and analysis/question mismatch. Require the Skill text to mention `storeAsArtifact`, all reference field names, and never instruct the Agent to copy transcript/questions/analyses.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test packages/agent/test/interview/generate-report.test.ts packages/agent/test/interview/skill-exposure.test.ts
```

Expected: FAIL because report and Skill still use full objects.

- [ ] **Step 3: Implement report resolution**

```ts
export interface GenerateReportInput {
    structuredInterviewArtifactId: string;
    analysisArtifactIds: string[];
    stage: "provisional" | "final";
    metadata?: Partial<InterviewMetadata>;
}
```

Resolve inputs, then retain existing consistency validation, deterministic scoring, summary generation, and Markdown rendering. Artifact errors are `input_error`; summary remains degradable.

- [ ] **Step 4: Rewrite Skill steps**

```text
read_file(path, storeAsArtifact: true) -> fileArtifactId
parse_transcript(sourceArtifactId) -> transcriptArtifactId
structure_interview(transcriptArtifactId) -> structuredInterviewArtifactId + questionIds
for questionId: analyze_answer(structuredInterviewArtifactId, questionId)
generate_report(structuredInterviewArtifactId, analysisArtifactIds, provisional)
```

Keep save/failure boundaries and remove pagination for Artifact mode.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --test packages/agent/test/interview/generate-report.test.ts packages/agent/test/interview/skill-exposure.test.ts
npm run typecheck --workspace @dkagent/agent
```

Expected: all exit 0.

- [ ] **Step 6: Commit Task 5 hunks only**

```bash
git add -p packages/agent/src/tools/tool-item/generate-report.ts packages/agent/test/interview/generate-report.test.ts packages/agent/skills/diagnose-transcript/SKILL.md packages/agent/test/interview/skill-exposure.test.ts
git diff --cached --check
git commit -m "feat(agent): generate reports from artifacts"
```

---

### Task 6: Web Tap Mapping and End-to-End Verification

**Files:**
- Modify: `packages/web-tap/src/web/model/types.ts`
- Modify: `packages/web-tap/src/web/model/project-events.ts`
- Modify: `packages/web-tap/src/web/shared/ModuleTag.tsx`
- Modify: `packages/web-tap/test/web/project-events.test.ts`
- Modify: `packages/web-tap/test/web/tap-app.test.tsx`
- Create: `packages/agent/test/interview/artifact-flow.integration.test.ts`

**Interfaces:**
- Produces `artifact_operation` Tap nodes and module label `产物`.
- Verifies the complete reference-only workflow.

- [ ] **Step 1: Write failing Web Tap tests**

```ts
expect(nodes.map((node) => node.kind)).toEqual([
    "artifact_operation",
    "artifact_operation",
]);
expect(nodes.map((node) => node.title)).toEqual(["创建产物", "读取产物"]);
expect(nodes.every((node) => node.module === "artifact")).toBe(true);
```

Render the module tag and require `产物`.

- [ ] **Step 2: Verify Web RED**

```bash
npm run test:web --workspace @dkagent/web-tap -- --run packages/web-tap/test/web/project-events.test.ts packages/web-tap/test/web/tap-app.test.tsx
```

Expected: FAIL because Artifact presentation does not exist.

- [ ] **Step 3: Implement minimal mapping**

Add `artifact_operation` to `TapNodeKind`, `artifact` to `TapModuleKind`, node definitions `创建产物`/`读取产物`, recognize the `artifact` prefix, and add:

```ts
artifact: { color: "green", label: "产物" },
```

Do not add a page, chart, or content preview.

- [ ] **Step 4: Write failing whole-chain boundary test**

Run the real Tool Registry with a shared Store and fake model responses. Include one successful analysis and one model failure. Assert intermediate serialized Tool Results do not contain the transcript sentence, `originalAnswer`, `strengths`, or `issues`; both analysis calls return Artifact IDs, the failed Artifact has `status: "failed"`, and the final report reaches expected coverage and Markdown still contains user-facing evidence.

```ts
assert.equal(JSON.stringify(readResult).includes(source), false);
assert.equal(JSON.stringify(structureResult).includes("originalAnswer"), false);
assert.ok(analyzeResults.every((item) => !JSON.stringify(item).includes("strengths")));
assert.equal(reportResult.data?.report.score.coverage.analyzed, 1);
assert.match(reportResult.data?.markdown ?? "", /面试分析报告/);
```

- [ ] **Step 5: Verify integration RED, then apply only exact boundary fixes**

```bash
npx tsx --test packages/agent/test/interview/artifact-flow.integration.test.ts
```

Expected: FAIL on any remaining large payload; after exact fixes, rerun and expect PASS.

- [ ] **Step 6: Run Web and Agent focused verification**

```bash
npm test --workspace @dkagent/web-tap
npm run typecheck --workspace @dkagent/web-tap
npm run build --workspace @dkagent/web-tap
npx tsx --test packages/agent/test/interview/artifact-flow.integration.test.ts
```

Expected: all exit 0; existing Vite chunk-size warning is allowed.

- [ ] **Step 7: Run real DKAgent with test.md**

```bash
npm run agent --workspace @dkagent/agent
```

In a fresh Session, analyze `/Users/xuxiaokang/apps/DKAgent/test.md` without saving. Verify every Tool reaches success, all scored questions produce analysis Artifacts, `generate_report` reaches the endpoint, intermediate Session Tool Results omit the 20,549-character transcript, and Trace contains linked metadata-only Artifact events.

- [ ] **Step 8: Run fresh full verification**

```bash
npm run typecheck
npm test
git diff --check
```

Expected: all typechecks/tests pass and diff check produces no output.

- [ ] **Step 9: Commit Task 6 hunks only**

```bash
git add packages/web-tap/src/web/model/types.ts packages/web-tap/src/web/model/project-events.ts packages/web-tap/src/web/shared/ModuleTag.tsx packages/web-tap/test/web/project-events.test.ts packages/web-tap/test/web/tap-app.test.tsx packages/agent/test/interview/artifact-flow.integration.test.ts
git add -p packages/agent/src packages/agent/test packages/trace
git diff --cached --check
git commit -m "test(agent): verify interview artifact workflow"
```

## Completion Evidence

- Store tests prove type checking, missing IDs, and Trace redaction.
- Tool tests prove no intermediate large values return to the Agent.
- Agent/CLI tests prove per-Session ownership.
- Web Tap tests prove Artifact flow is visible in Chinese.
- Real `test.md` execution reaches `generate_report`.
- Root typecheck/tests and `git diff --check` exit 0.
