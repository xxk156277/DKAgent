# Promptfoo Agent Tool Calling Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Promptfoo evaluation command that runs five deterministic file-tool cases through the real DKAgent `AgentLoop` and grades the final answer, existing `TraceEvent[]`, and the M3 output file.

**Architecture:** A TypeScript Promptfoo provider creates one temporary workspace per case, constructs the real DKAgent provider/query/context/agent stack, injects `MemoryTraceStore`, and returns the answer plus sanitized DKAgent trace metadata. Pure selectors and one reusable assertion function compare that evidence with assertion-local expectations; DKAgent Trace remains the only execution-event schema.

**Tech Stack:** TypeScript 7, Node.js 22, pnpm 11, Node test runner, Promptfoo 0.121.19, existing DKAgent AgentLoop/QueryEngine/Trace/filesystem Tools.

## Global Constraints

- Execute in an isolated Git worktree created from the approved design commit `ef26c54`; do not touch the current dirty `main` worktree or its `package.json`/`packages/rag-v2` changes.
- Before implementation, use `dkagent-project-manager` worker-start with task ID `DKA-20260826-AGENT-EVAL`; use worker-finish only after behavior-relevant verification.
- WIP=1: complete and verify M1, then M2, then M3.
- Keep Promptfoo config, test cases, result database, and reports local. The configured DKAgent remote model provider is the only allowed external data recipient.
- Set `PROMPTFOO_DISABLE_TELEMETRY=1`, `PROMPTFOO_DISABLE_UPDATE=1`, `PROMPTFOO_DISABLE_REMOTE_GENERATION=true`, `PROMPTFOO_DISABLE_SHARING=1`, and `PROMPTFOO_CONFIG_DIR=.dkagent/promptfoo` in the run script.
- Run every real evaluation with `--no-cache`; never copy API keys into config, metadata, fixtures, logs, or committed files.
- Reuse `TraceEvent[]` directly. Do not add another persisted trajectory schema, OTLP conversion, Web Tap integration, Session, Memory, Context compaction, Judge, CI, or interview Tool evaluation.
- The only cases are `read-file`, `no-tool`, `find-files`, `grep-files`, and `read-then-write`.
- A real-model pass proves only the current provider/model/configuration run. If credentials or network are unavailable, report `needs_verification`; do not claim completion from Fake Provider tests.

---

## File Structure

```text
package.json                                      # local eval/test/typecheck scripts
pnpm-lock.yaml                                   # pinned Promptfoo dependency graph
evals/agent-loop/tsconfig.json                   # standalone strict typecheck target
evals/agent-loop/trace-selectors.ts              # pure readers over TraceEvent[]
evals/agent-loop/assertions.ts                    # reusable Promptfoo grading function
evals/agent-loop/assertions.test.ts               # synthetic Trace grader tests
evals/agent-loop/provider.ts                      # temp workspace + real AgentLoop adapter
evals/agent-loop/provider.test.ts                 # Fake Provider adapter integration tests
evals/agent-loop/promptfooconfig.ts               # five inline cases and expectations
evals/agent-loop/fixtures/read-file/notes.txt
evals/agent-loop/fixtures/no-tool/README.txt
evals/agent-loop/fixtures/find-files/src/a.ts
evals/agent-loop/fixtures/find-files/src/b.ts
evals/agent-loop/fixtures/find-files/README.md
evals/agent-loop/fixtures/grep-files/hit.txt
evals/agent-loop/fixtures/grep-files/miss.txt
evals/agent-loop/fixtures/read-then-write/source.txt
```

`assertions.ts` owns only evaluation expectations and grading. `provider.ts` owns only execution and evidence capture; it must not read assertion expectations. `promptfooconfig.ts` is the composition root.

---

### Task 1: Build the Trace selector and assertion core

**Files:**
- Create: `evals/agent-loop/tsconfig.json`
- Create: `evals/agent-loop/trace-selectors.ts`
- Create: `evals/agent-loop/assertions.ts`
- Create: `evals/agent-loop/assertions.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `TraceEvent` from `@dkagent/trace`; Promptfoo `AssertionValueFunctionContext` and `GradingResult`.
- Produces: `selectToolCalls(events)`, `selectToolResults(events)`, `findUnpairedToolCallIds(events)`, `hasNormalTermination(events)`, and `gradeAgentRun(output, context)`.

- [ ] **Step 1: Add the pinned evaluation dependency**

Run:

```bash
pnpm add -D promptfoo@0.121.19
```

Expected: `package.json` contains exact `"promptfoo": "0.121.19"` and `pnpm-lock.yaml` changes only for the dependency graph. Preserve unrelated scripts already present in the isolated worktree.

- [ ] **Step 2: Add the eval typecheck target and root verification scripts**

Create `evals/agent-loop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "../..",
    "noEmit": true
  },
  "include": ["./**/*.ts"]
}
```

Add these root scripts without deleting existing scripts:

```json
{
  "scripts": {
    "test:agent-eval": "tsx --test evals/agent-loop/*.test.ts",
    "typecheck:agent-eval": "tsc -p evals/agent-loop/tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 3: Write the failing selector and grader tests**

Create `evals/agent-loop/assertions.test.ts` with helpers that construct canonical events and these tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { TraceEvent } from "@dkagent/trace";
import { gradeAgentRun } from "./assertions.js";
import {
  findUnpairedToolCallIds,
  hasNormalTermination,
  selectToolCalls,
  selectToolResults,
} from "./trace-selectors.js";

function event(
  sequence: number,
  name: TraceEvent["name"],
  phase: TraceEvent["phase"],
  data: unknown,
): TraceEvent {
  return {
    id: `event-${sequence}`,
    traceId: "trace-1",
    spanId: `span-${sequence}`,
    sequence,
    timestamp: "2026-08-26T00:00:00.000Z",
    name,
    phase,
    step: 1,
    data,
  };
}

const completeReadTrace: TraceEvent[] = [
  event(1, "agent.turn", "start", { input: "读取 notes.txt" }),
  event(2, "tool.call", "start", {
    input: { id: "call-1", name: "read_file", input: { path: "notes.txt" } },
  }),
  event(3, "tool.result", "event", {
    toolCallId: "call-1",
    name: "read_file",
    input: { path: "notes.txt" },
    result: { success: true, data: { content: "DKAGENT_EVAL_7319" } },
  }),
  event(4, "tool.call", "end", {
    output: { toolCallId: "call-1", name: "read_file" },
  }),
  event(5, "agent.turn", "end", { output: { answer: "DKAGENT_EVAL_7319" } }),
];

test("selectors only count tool.call start and tool.result event", () => {
  assert.deepEqual(selectToolCalls(completeReadTrace).map((call) => call.name), ["read_file"]);
  assert.equal(selectToolResults(completeReadTrace).length, 1);
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace), []);
  assert.equal(hasNormalTermination(completeReadTrace), true);
});

test("grader reports required tool, pairing, result, output, and termination", () => {
  const result = gradeAgentRun("验证码是 DKAGENT_EVAL_7319", {
    vars: {},
    test: {} as never,
    providerResponse: {
      output: "验证码是 DKAGENT_EVAL_7319",
      metadata: { evalRun: { caseId: "read-file", traceEvents: completeReadTrace } },
    },
    config: {
      requiredTools: ["read_file"],
      outputIncludes: "DKAGENT_EVAL_7319",
    },
  } as never);

  assert.equal(result.pass, true);
  assert.equal(result.componentResults?.every((component) => component.pass), true);
});

test("grader identifies an unpaired call", () => {
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace.slice(0, 2)), ["call-1"]);
});
```

- [ ] **Step 4: Run the test to verify RED**

Run:

```bash
pnpm run test:agent-eval
```

Expected: FAIL because `assertions.ts` and `trace-selectors.ts` do not exist.

- [ ] **Step 5: Implement minimal Trace selectors**

Create `evals/agent-loop/trace-selectors.ts`:

```ts
import type { TraceEvent } from "@dkagent/trace";

export interface EvalToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  sequence: number;
  step?: number;
}

export interface EvalToolResult {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result: {
    success: boolean;
    data?: unknown;
    error?: { code: string; message: string };
  };
  sequence: number;
  step?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function selectToolCalls(events: readonly TraceEvent[]): EvalToolCall[] {
  return events.flatMap((traceEvent) => {
    if (traceEvent.name !== "tool.call" || traceEvent.phase !== "start") return [];
    const call = record(record(traceEvent.data)?.input);
    const input = record(call?.input);
    if (typeof call?.id !== "string" || typeof call.name !== "string" || !input) return [];
    return [{
      id: call.id,
      name: call.name,
      input,
      sequence: traceEvent.sequence,
      ...(traceEvent.step === undefined ? {} : { step: traceEvent.step }),
    }];
  });
}

export function selectToolResults(events: readonly TraceEvent[]): EvalToolResult[] {
  return events.flatMap((traceEvent) => {
    if (traceEvent.name !== "tool.result" || traceEvent.phase !== "event") return [];
    const dispatched = record(traceEvent.data);
    const input = record(dispatched?.input);
    const result = record(dispatched?.result);
    if (
      typeof dispatched?.toolCallId !== "string"
      || typeof dispatched.name !== "string"
      || !input
      || typeof result?.success !== "boolean"
    ) return [];
    return [{
      toolCallId: dispatched.toolCallId,
      name: dispatched.name,
      input,
      result: result as EvalToolResult["result"],
      sequence: traceEvent.sequence,
      ...(traceEvent.step === undefined ? {} : { step: traceEvent.step }),
    }];
  });
}

export function findUnpairedToolCallIds(events: readonly TraceEvent[]): string[] {
  const resultIds = new Set(selectToolResults(events).map((item) => item.toolCallId));
  return selectToolCalls(events)
    .filter((call) => !resultIds.has(call.id))
    .map((call) => call.id);
}

export function hasNormalTermination(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.name === "agent.turn" && event.phase === "end")
    && !events.some((event) => event.name === "agent.turn" && event.phase === "error");
}
```

- [ ] **Step 6: Implement the M1 assertion**

Create `evals/agent-loop/assertions.ts` with exported contracts and a `component()` helper. The M1 body must produce separate components for run error, required Tool presence, successful required Tool Results, Call/Result pairing, `outputIncludes`, and normal termination:

```ts
import type {
  AssertionValueFunctionContext,
  GradingResult,
} from "promptfoo";
import type { TraceEvent } from "@dkagent/trace";
import {
  findUnpairedToolCallIds,
  hasNormalTermination,
  selectToolCalls,
  selectToolResults,
} from "./trace-selectors.js";

export interface AgentEvalRunMetadata {
  caseId: string;
  traceEvents: TraceEvent[];
  runError?: { stage: "setup" | "model" | "agent" | "cleanup"; message: string };
  finalFiles?: Record<string, string>;
}

export interface AgentAssertionConfig {
  requiredTools?: string[];
  forbiddenTools?: string[];
  outputIncludes?: string;
  requireNoTools?: boolean;
  expectedSequence?: string[];
  expectedFindFiles?: string[];
  expectedGrep?: { path: string; text: string };
  expectedFinalFiles?: Record<string, string>;
}

function component(pass: boolean, reason: string): GradingResult {
  return { pass, score: pass ? 1 : 0, reason };
}

export function gradeAgentRun(
  output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const config = (context.config ?? {}) as AgentAssertionConfig;
  const metadata = context.providerResponse?.metadata?.evalRun as
    | AgentEvalRunMetadata
    | undefined;
  if (!metadata) return component(false, "Provider 未返回 evalRun metadata");

  const calls = selectToolCalls(metadata.traceEvents);
  const results = selectToolResults(metadata.traceEvents);
  const requiredTools = config.requiredTools ?? [];
  const components: GradingResult[] = [
    component(metadata.runError === undefined, metadata.runError?.message ?? "Agent Run 无错误"),
    component(
      requiredTools.every((name) => calls.some((call) => call.name === name)),
      `必要 Tool: ${requiredTools.join(", ") || "无"}`,
    ),
    component(
      requiredTools.every((name) => results.some((item) => item.name === name && item.result.success)),
      "必要 Tool Result 成功",
    ),
    component(findUnpairedToolCallIds(metadata.traceEvents).length === 0, "Tool Call/Result 完整配对"),
    component(
      config.outputIncludes === undefined || output.includes(config.outputIncludes),
      config.outputIncludes === undefined ? "无需文本标记" : `回答包含 ${config.outputIncludes}`,
    ),
    component(hasNormalTermination(metadata.traceEvents), "Agent 正常结束"),
  ];
  const pass = components.every((item) => item.pass);
  return { pass, score: pass ? 1 : 0, reason: pass ? "全部组件通过" : "存在失败组件", componentResults: components };
}
```

- [ ] **Step 7: Verify GREEN and types**

Run:

```bash
pnpm run test:agent-eval
pnpm run typecheck:agent-eval
```

Expected: all assertion tests PASS and typecheck exits 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add package.json pnpm-lock.yaml evals/agent-loop/tsconfig.json evals/agent-loop/trace-selectors.ts evals/agent-loop/assertions.ts evals/agent-loop/assertions.test.ts
git commit -m "test(agent): add trace evaluation core"
```

---

### Task 2: Deliver M1 with the real AgentLoop and `read_file`

**Files:**
- Create: `evals/agent-loop/provider.ts`
- Create: `evals/agent-loop/provider.test.ts`
- Create: `evals/agent-loop/promptfooconfig.ts`
- Create: `evals/agent-loop/fixtures/read-file/notes.txt`
- Modify: `package.json`

**Interfaces:**
- Consumes: `gradeAgentRun`, existing DKAgent config/provider/context/agent/trace/read Tool.
- Produces: `runAgentEvalCase(options): Promise<ProviderResponse>` and `DkAgentEvalProvider implements ApiProvider`.

- [ ] **Step 1: Add the M1 fixture**

Create `evals/agent-loop/fixtures/read-file/notes.txt`:

```text
这是 DKAgent Agent Eval Fixture。
验证码：DKAGENT_EVAL_7319
```

- [ ] **Step 2: Write a failing Provider integration test**

Create `provider.test.ts` with a local `LLMProvider` that emits one `read_file` call followed by `验证码是 DKAGENT_EVAL_7319`. Call `runAgentEvalCase()` with `enabledTools: ["read_file"]`, then assert:

```ts
assert.equal(response.output, "验证码是 DKAGENT_EVAL_7319");
const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
assert.equal(metadata.caseId, "read-file");
assert.equal(metadata.runError, undefined);
assert.deepEqual(selectToolCalls(metadata.traceEvents).map((call) => call.name), ["read_file"]);
assert.deepEqual(findUnpairedToolCallIds(metadata.traceEvents), []);
```

The fake stream must use production protocol events:

```ts
[
  { type: "tool_call_start", index: 0, id: "call-read", name: "read_file" },
  { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"notes.txt"}' },
  { type: "tool_call_end", index: 0 },
  { type: "message_end", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "tool_use" },
]
```

- [ ] **Step 3: Run the Provider test to verify RED**

```bash
pnpm run test:agent-eval
```

Expected: FAIL because `provider.ts` does not exist.

- [ ] **Step 4: Implement the execution adapter**

Implement `provider.ts` with these exact boundaries:

```ts
export interface RunAgentEvalCaseOptions {
  caseId: string;
  prompt: string;
  enabledTools: Array<"read_file" | "find_files" | "grep_files" | "write_file">;
  captureFiles?: string[];
  provider: LLMProvider;
  model: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  secrets?: string[];
}

export async function runAgentEvalCase(
  options: RunAgentEvalCaseOptions,
): Promise<ProviderResponse>;
```

Implementation sequence:

1. `mkdtemp(join(tmpdir(), "dkagent-agent-eval-"))` creates `runRoot`.
2. Copy `fixtures/<caseId>` to the previously nonexistent `runRoot/workspace` using `cp(..., { recursive: true })`.
3. Create `MemoryTraceStore`, `Tracer`, `ToolRegistry`, `QueryEngine`, and `ContextManager(new ProviderTokenCounter(provider), undefined, tracer)`.
4. Register only the Tool names in `enabledTools`, each created with `workspace` as `cwd`.
5. Construct `AgentLoop` with `AGENT_SYSTEM_PROMPT`, `maxSteps: 12`, no Session, no Memory, and no `contextCompaction`.
6. Run `agent.run(prompt)`; classify errors as `model` when a `model.request/error` Trace exists, otherwise `agent`.
7. Read only names from `captureFiles` before cleanup; store successful UTF-8 contents under `finalFiles`.
8. Map `traceStore.list()` through the existing `sanitizeTraceEvent()`, then redact every exact configured secret from all serializable metadata strings before returning it. Remove `runRoot` in `finally`.
9. A cleanup failure sets `runError.stage = "cleanup"` and must fail grading.

`DkAgentEvalProvider.callApi(prompt, context)` must load the existing DKAgent config, read only `caseId` and optional `captureFiles` from `context.vars`, instantiate `OpenAICompatibleProvider`, and call `runAgentEvalCase`. Setup/config errors return `{ error: safeMessage }`; expectation data is never passed to this class.

- [ ] **Step 5: Verify the Fake Provider integration**

```bash
pnpm run test:agent-eval
pnpm run typecheck:agent-eval
```

Expected: all tests PASS and typecheck exits 0.

- [ ] **Step 6: Add the M1 Promptfoo composition root**

Create a TypeScript `UnifiedConfig` in `promptfooconfig.ts`:

```ts
import type { UnifiedConfig } from "promptfoo";
import { gradeAgentRun } from "./assertions.js";
import { DkAgentEvalProvider } from "./provider.js";

const config: UnifiedConfig = {
  description: "DKAgent AgentLoop file Tool evaluation",
  prompts: ["{{input}}"],
  providers: [new DkAgentEvalProvider(["read_file"])],
  tests: [{
    description: "M1 read_file reads a fixture and returns its marker",
    vars: {
      caseId: "read-file",
      input: "请读取 notes.txt，并告诉我其中的验证码。",
    },
    metadata: { milestone: "M1" },
    options: { runSerially: true },
    assert: [{
      type: "javascript",
      value: gradeAgentRun,
      config: {
        requiredTools: ["read_file"],
        outputIncludes: "DKAGENT_EVAL_7319",
      },
    }],
  }],
};

export default config;
```

Add the local-only root command, retaining existing scripts:

```json
{
  "scripts": {
    "eval:agent": "PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_UPDATE=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true PROMPTFOO_DISABLE_SHARING=1 PROMPTFOO_CONFIG_DIR=.dkagent/promptfoo NODE_OPTIONS='--import tsx' promptfoo eval -c evals/agent-loop/promptfooconfig.ts --no-cache"
  }
}
```

- [ ] **Step 7: Run the real M1 acceptance**

Run from the repository root with the existing `.env`/provider configuration:

```bash
npm run eval:agent
```

Expected: exactly one Case executes; Promptfoo reports PASS for Tool selection, successful Result, pairing, marker, and normal termination. Results stay under `.dkagent/promptfoo/`.

If credentials/network are unavailable or the real model fails the case, record the exact failure and stop M2; do not weaken the assertion or use cached/Fake output as acceptance.

- [ ] **Step 8: Commit M1**

```bash
git add package.json evals/agent-loop/provider.ts evals/agent-loop/provider.test.ts evals/agent-loop/promptfooconfig.ts evals/agent-loop/fixtures/read-file/notes.txt
git commit -m "feat(agent): add promptfoo read tool eval"
```

---

### Task 3: Add M2 no-tool, find, and grep cases

**Files:**
- Modify: `evals/agent-loop/assertions.ts`
- Modify: `evals/agent-loop/assertions.test.ts`
- Modify: `evals/agent-loop/provider.ts`
- Modify: `evals/agent-loop/promptfooconfig.ts`
- Create: `evals/agent-loop/fixtures/no-tool/README.txt`
- Create: `evals/agent-loop/fixtures/find-files/src/a.ts`
- Create: `evals/agent-loop/fixtures/find-files/src/b.ts`
- Create: `evals/agent-loop/fixtures/find-files/README.md`
- Create: `evals/agent-loop/fixtures/grep-files/hit.txt`
- Create: `evals/agent-loop/fixtures/grep-files/miss.txt`

**Interfaces:**
- Extends: `gradeAgentRun` with `requireNoTools`, `forbiddenTools`, `expectedFindFiles`, and `expectedGrep`.
- Provider now exposes `read_file`, `find_files`, and `grep_files` to every M1/M2 Case.

- [ ] **Step 1: Add deterministic fixtures**

Use these exact contents:

```text
# fixtures/no-tool/README.txt
This workspace is intentionally unused by the no-tool case.
```

```ts
// fixtures/find-files/src/a.ts
export const a = 1;

// fixtures/find-files/src/b.ts
export const b = 2;
```

```text
# fixtures/find-files/README.md
This file must not appear in the TypeScript result set.
```

```text
# fixtures/grep-files/hit.txt
search marker: DKAGENT_GREP_4821

# fixtures/grep-files/miss.txt
this file has no target marker
```

- [ ] **Step 2: Write failing M2 grader tests**

Add three tests using synthetic traces:

1. `requireNoTools: true` passes for a normal `agent.turn/end` trace and fails when any `tool.call/start` is present.
2. `expectedFindFiles: ["src/a.ts", "src/b.ts"]` reads `tool.result.data.files`, compares a sorted set, and rejects a result containing `README.md`.
3. `expectedGrep: { path: "hit.txt", text: "DKAGENT_GREP_4821" }` reads `tool.result.data.matches` and requires one match containing both values.

- [ ] **Step 3: Run M2 tests to verify RED**

```bash
pnpm run test:agent-eval
```

Expected: the new tests FAIL because the M2 components are not implemented.

- [ ] **Step 4: Implement only the M2 components**

Extend `gradeAgentRun`:

- `requireNoTools` checks `calls.length === 0`.
- `forbiddenTools` checks no selected call name is forbidden.
- `expectedFindFiles` finds the successful `find_files` result, validates `data.files` as strings, sorts them, and requires exact set equality.
- `expectedGrep` finds the successful `grep_files` result, validates `data.matches`, and requires one `{ path, text }` containing the configured values.

Do not add generic metric aggregation, fuzzy matching, retries, or Judge calls.

- [ ] **Step 5: Expose M2 Tools and add three cases**

Change the config Provider to:

```ts
new DkAgentEvalProvider(["read_file", "find_files", "grep_files"])
```

Add these cases:

```ts
{
  description: "M2 no-tool answers directly",
  vars: { caseId: "no-tool", input: "请直接回复：READY。不要调用任何工具。" },
  metadata: { milestone: "M2" },
  options: { runSerially: true },
  assert: [{
    type: "javascript",
    value: gradeAgentRun,
    config: { requireNoTools: true, outputIncludes: "READY" },
  }],
}
```

Use `caseId: "find-files"` with input `请查找 src 目录下的所有 TypeScript 文件，并列出结果。` and config:

```ts
{
  requiredTools: ["find_files"],
  forbiddenTools: ["write_file"],
  expectedFindFiles: ["src/a.ts", "src/b.ts"],
}
```

Use `caseId: "grep-files"` with input `请搜索哪些文件包含 DKAGENT_GREP_4821，并告诉我文件名。` and config:

```ts
{
  requiredTools: ["grep_files"],
  forbiddenTools: ["write_file"],
  expectedGrep: { path: "hit.txt", text: "DKAGENT_GREP_4821" },
}
```

The no-tool Case has its own fixture directory so `caseId` remains a stable, unique identifier. Its prompt neither reveals nor requests workspace content.

- [ ] **Step 6: Verify M2 locally and with the real model**

```bash
pnpm run test:agent-eval
pnpm run typecheck:agent-eval
npm run eval:agent
```

Expected: unit tests/typecheck pass and Promptfoo executes four serial Cases. M1 remains green; M2 component failures, if any, identify no-tool, file set, or grep match separately.

- [ ] **Step 7: Commit M2**

```bash
git add evals/agent-loop
git commit -m "test(agent): add find and grep eval cases"
```

---

### Task 4: Add M3 read-then-write outcome verification

**Files:**
- Modify: `evals/agent-loop/assertions.ts`
- Modify: `evals/agent-loop/assertions.test.ts`
- Modify: `evals/agent-loop/provider.ts`
- Modify: `evals/agent-loop/provider.test.ts`
- Modify: `evals/agent-loop/promptfooconfig.ts`
- Create: `evals/agent-loop/fixtures/read-then-write/source.txt`

**Interfaces:**
- Extends Provider input with `captureFiles` read from Promptfoo test metadata/vars but never rendered into the model prompt.
- Extends grading with ordered Tool names and exact final-file contents.

- [ ] **Step 1: Add the write fixture**

Create `source.txt`:

```text
DKAgent write evaluation payload
line two remains unchanged
```

- [ ] **Step 2: Write failing M3 tests**

Add assertion tests proving:

- `expectedSequence: ["read_file", "write_file"]` passes only when the selected calls appear in that order.
- `expectedFinalFiles: { "result.txt": "DKAgent write evaluation payload\nline two remains unchanged\n" }` requires exact content.

Extend `provider.test.ts` with a three-response Fake Provider:

1. Calls `read_file({ path: "source.txt" })`.
2. Calls `write_file({ path: "result.txt", content: "DKAgent write evaluation payload\nline two remains unchanged\n", overwrite: false })`.
3. Returns `result.txt 已创建`.

Call `runAgentEvalCase` with `captureFiles: ["result.txt"]` and assert `metadata.finalFiles?.["result.txt"]` equals the fixture content.

- [ ] **Step 3: Run M3 tests to verify RED**

```bash
pnpm run test:agent-eval
```

Expected: new sequence/final-file/capture tests FAIL.

- [ ] **Step 4: Implement sequence and state grading**

- Compare `expectedSequence` with the selected call names ordered by Trace `sequence`; require exact equality for M3.
- Compare every `expectedFinalFiles` entry with `metadata.finalFiles`; missing files fail with a named component.
- Do not add a general recursive workspace snapshot or Diff.

- [ ] **Step 5: Capture requested final files before cleanup**

In `DkAgentEvalProvider.callApi`, read `context?.vars?.captureFiles` only as a string array passed to `runAgentEvalCase`. Because the Prompt template contains only `{{input}}`, it is never sent to the model.

In `runAgentEvalCase`, resolve every capture path under the temporary workspace using the same containment invariant as filesystem Tools, read it after `AgentLoop.run()` and before `rm()`, and store UTF-8 content under the original relative name. A missing expected file remains absent from `finalFiles` so the Outcome assertion fails; it is not a Provider setup error.

- [ ] **Step 6: Add `write_file` and the fifth Case**

Expose all four Tools:

```ts
new DkAgentEvalProvider(["read_file", "find_files", "grep_files", "write_file"])
```

Add:

```ts
{
  description: "M3 reads source.txt and writes exact result.txt",
  vars: {
    caseId: "read-then-write",
    input: "请读取 source.txt 的完整内容，将内容原样写入新的 result.txt，不要修改 source.txt。",
    captureFiles: ["result.txt"],
  },
  metadata: { milestone: "M3" },
  options: { runSerially: true },
  assert: [{
    type: "javascript",
    value: gradeAgentRun,
    config: {
      requiredTools: ["read_file", "write_file"],
      expectedSequence: ["read_file", "write_file"],
      expectedFinalFiles: {
        "result.txt": "DKAgent write evaluation payload\nline two remains unchanged\n",
      },
    },
  }],
}
```

- [ ] **Step 7: Verify the full five-Case slice**

```bash
pnpm run test:agent-eval
pnpm run typecheck:agent-eval
pnpm --filter @dkagent/agent test
pnpm --filter @dkagent/agent typecheck
npm run eval:agent
git diff --check
```

Expected:

- assertion/provider tests pass;
- Agent package tests and typecheck pass;
- Promptfoo runs exactly five serial Cases with `--no-cache`;
- M3 shows separate Tool sequence, Result pairing, final-file content, and termination components;
- results exist only under ignored `.dkagent/promptfoo/`;
- no unrelated `packages/rag-v2` or project-management document changes appear in the feature worktree.

- [ ] **Step 8: Commit M3**

```bash
git add evals/agent-loop
git commit -m "test(agent): verify write tool outcome"
```

- [ ] **Step 9: Emit project completion evidence**

Use `dkagent-project-manager` worker-finish for `DKA-20260826-AGENT-EVAL`:

- `test`: `pnpm run test:agent-eval`
- `typecheck`: `pnpm run typecheck:agent-eval`
- `test`: `pnpm --filter @dkagent/agent test`
- `typecheck`: `pnpm --filter @dkagent/agent typecheck`
- `user_confirmation` only if the user explicitly accepts the real five-Case Promptfoo output.

If `npm run eval:agent` was not run successfully against the configured real model, finish as `needs_verification`, not `completed`.

---

## Plan Self-Review Checklist

- Every approved Case appears exactly once: M1 `read-file`; M2 `no-tool`, `find-files`, `grep-files`; M3 `read-then-write`.
- Expected behavior lives only in assertion `config`; Provider receives only `caseId`, rendered prompt, Tool availability, and optional capture-file names.
- `TraceEvent[]` remains the only execution trace schema; selector views are process-local and derived.
- No task adds Judge, OTLP, Web Tap, CI, Session, Memory, Context compaction, safety/error datasets, repetition, or aggregated metrics.
- Fake Provider tests prove adapter mechanics only; real-model `npm run eval:agent` remains mandatory acceptance evidence.
- All package changes are isolated from the dirty main worktree and preserve unrelated scripts.
