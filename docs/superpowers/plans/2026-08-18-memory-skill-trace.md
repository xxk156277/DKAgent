# Memory 与 Skill Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 让 Memory、Skill 及其内部模型调用成为 Web Tap 中可读、可归属、可统计且符合隐私边界的正式 Trace 节点。

**Architecture:** 在 Memory/Skill 编排边界显式打点，不改 QueryEngine 全局行为。@dkagent/trace 增加 module、operation 日志元数据；Web Tap 按元数据和事件名投影中文节点，旧事件继续按前缀兼容。

**Tech Stack:** TypeScript 7、Node.js AsyncLocalStorage、React 19、Zustand、Ant Design 6、Vitest、Node Test Runner

## Global Constraints

- 按用户要求，不采用 TDD 红绿循环；先实现，再补针对性验证并运行现有回归。
- 不给 AgentMessage、ConversationContextState、MemoryEntry、Tool 参数和 Skill 结果增加 Tap 展示字段。
- Skill 模型输入输出完整记录；Memory 模型输入输出保留结构，但在 TraceEvent 创建前脱敏。
- Memory Trace 不得包含用户原文、回答原文和完整 Memory content。
- Skill 内部阶段不得伪装成 tool.call；顶层 Tool 指标保持不变。
- 技术字段使用英文；中文只定义在 Web Tap。
- 不调整布局样式，不增加数据库、图表、搜索、采样或成本计算。
- 不修改或提交 .dkagent/sessions.db 与 test.md。

---

### Task 1: Trace 元数据契约

**Files**

- Modify: packages/trace/src/types.ts
- Modify: packages/trace/src/tracer.ts
- Modify: packages/trace/src/sanitize.ts
- Test: packages/trace/test/tracer-session.test.ts

**Produces:** TraceModule；TraceEvent 和 TraceEventOptions 的 module、operation；skill.run、skill.stage。

- [ ] **Step 1: 扩展类型**

~~~ts
export type TraceModule =
  | "agent"
  | "context"
  | "memory"
  | "skill"
  | "tool"
  | "model"
  | "session";

// 在现有 TraceEventName 联合尾部追加
| "skill.run"
| "skill.stage";

export interface TraceEvent<TData = unknown> {
  // 保留全部现有字段
  module?: TraceModule;
  operation?: string;
  data: TData;
}

export interface TraceEventOptions {
  step?: number;
  module?: TraceModule;
  operation?: string;
}
~~~

- [ ] **Step 2: 传播元数据**

给 ActiveTraceContext、runSpan parent 和 publish context 增加 module、operation。span()、event() 使用调用参数优先、异步上下文其次：

~~~ts
const module = options.module ?? active?.module;
const operation = options.operation ?? active?.operation;
~~~

TraceSpan.event、AsyncLocalStorage、start/end/error 使用当前 Span 元数据。TraceEvent 构造使用：

~~~ts
...(context.module === undefined ? {} : { module: context.module }),
...(context.operation === undefined ? {} : { operation: context.operation }),
~~~

sanitize fallback 同时保留 sessionId、module、operation。

- [ ] **Step 3: 补实现后测试**

创建 skill.stage → model.request → model.response，断言所有事件 module=skill、operation=analyze_answer，Span 生命周期和子 Event 一致；现有无 Session/无 metadata 测试保持通过。

- [ ] **Step 4: 验证并提交**

~~~bash
npm test -w @dkagent/trace
npm run typecheck -w @dkagent/trace
git diff --check
git add packages/trace/src/types.ts packages/trace/src/tracer.ts packages/trace/src/sanitize.ts packages/trace/test/tracer-session.test.ts
git commit -m "feat(trace): add module operation metadata"
~~~

Expected: Trace 测试、类型检查通过，diff check 无输出，提交仅含四个文件。

---

### Task 2: Memory 模型链路与脱敏

**Files**

- Modify: packages/agent/src/agent/loop.ts
- Modify: packages/agent/src/memory/extractor.ts
- Modify: packages/agent/src/memory/writer.ts
- Test: packages/agent/test/memory/writer.test.ts
- Test: packages/agent/test/phase1/agent-loop.test.ts

**Consumes:** Task 1 的 module、operation。

**Produces:** memory.extract → model.request → model.response；带归属的 recall/write；无 Memory 原文的事件。

- [ ] **Step 1: 标记现有 Span**

safeRecall() 增加：

~~~ts
{ module: "memory", operation: "recall" }
~~~

safeCapture() 增加：

~~~ts
{ module: "memory", operation: "write" }
~~~

writer.ts 的安全统计 Event 增加：

~~~ts
{ module: "memory", operation: "persist" }
~~~

- [ ] **Step 2: 构造安全请求**

extractor.ts 增加：

~~~ts
function createMemoryTraceRequest(request: ModelRequest, input: MemoryCaptureInput) {
  return {
    model: request.model,
    systemPrompt: request.systemPrompt,
    messages: [{ role: "user", content: "[MEMORY_INPUT_REDACTED]" }],
    tools: request.tools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    inputSummary: {
      userInputCharacterCount: input.userInput.length,
      answerCharacterCount: input.assistantAnswer.length,
    },
  };
}
~~~

- [ ] **Step 3: 构造安全响应**

文本响应把 content 替换为 [MEMORY_CONTENT_REDACTED]。Tool 响应只保留 id、name、usage、stopReason 和候选 type/key；候选 content 固定替换。未知 Tool 输入不得复制。

~~~ts
function readCandidateIdentities(value: unknown): Array<{ type?: unknown; key?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => isRecord(candidate)
    ? { type: candidate.type, key: candidate.key }
    : {});
}
~~~

- [ ] **Step 4: 改为嵌套 Span**

~~~ts
return this.tracer.span(
  "memory.extract",
  {
    userInputCharacterCount: input.userInput.length,
    answerCharacterCount: input.assistantAnswer.length,
  },
  async (extractSpan) => {
    const response = await this.tracer.span(
      "model.request",
      createMemoryTraceRequest(request, input),
      async (modelSpan) => {
        const result = await this.queryEngine.query(request);
        const safeResponse = createMemoryTraceResponse(result);
        modelSpan.event("model.response", safeResponse);
        modelSpan.setOutput(safeResponse);
        return result;
      },
      { module: "memory", operation: "extract" },
    );
    const parsed = response.type === "tool_use"
      ? this.parseCandidates(response.toolCalls)
      : { candidates: [], rejectedCount: 0 };
    extractSpan.setOutput({
      candidateCount: parsed.candidates.length,
      rejectedCount: parsed.rejectedCount,
      memories: parsed.candidates.map(({ type, key }) => ({ type, key })),
    });
    return parsed.candidates;
  },
  { module: "memory", operation: "extract" },
);
~~~

删除旧的单个 memory.extract Event。

- [ ] **Step 5: 补实现后测试**

断言 memory.extract phases 为 start/end；存在 module=memory、operation=extract 的 model request/response；序列化事件不匹配用户原文、回答原文和候选 content，但匹配 MEMORY_INPUT_REDACTED 与 MEMORY_CONTENT_REDACTED。AgentLoop 测试断言 recall/write 归属且回答不变。

- [ ] **Step 6: 验证并提交**

~~~bash
npm run test:memory -w @dkagent/agent
npm run test:phase1 -w @dkagent/agent
npm run typecheck:memory -w @dkagent/agent
npm run typecheck:phase1 -w @dkagent/agent
git diff --check
git add packages/agent/src/agent/loop.ts packages/agent/src/memory/extractor.ts packages/agent/src/memory/writer.ts packages/agent/test/memory/writer.test.ts packages/agent/test/phase1/agent-loop.test.ts
git commit -m "feat(agent): trace memory model lifecycle"
~~~

Expected: Memory、Phase 1 测试和类型检查通过；用户文件不进入提交。

---

### Task 3: Skill 阶段与内部模型

**Files**

- Modify: packages/agent/src/tools/types.ts
- Modify: packages/agent/src/agent/loop.ts
- Create: packages/agent/src/skills/skill-trace.ts
- Modify: packages/agent/src/skills/diagnose-transcript.ts
- Modify: packages/agent/src/interview/model-json.ts
- Modify: packages/agent/src/interview/structurer.ts
- Modify: packages/agent/src/tools/tool-item/preprocess-transcript.ts
- Modify: packages/agent/src/tools/tool-item/extract-project-facts.ts
- Modify: packages/agent/src/tools/tool-item/analyze-expression.ts
- Modify: packages/agent/src/tools/tool-item/analyze-answer.ts
- Modify: packages/agent/src/tools/tool-item/generate-report.ts
- Test: packages/agent/test/interview/analyze-interview.integration.test.ts

**Produces:** ToolContext.tracer?: Tracer；observeSkillOperation()；成对的 Skill model.request/response。

- [ ] **Step 1: 注入 Tracer**

~~~ts
import type { Tracer } from "@dkagent/trace";

export interface ToolContext {
  queryEngine: QueryEngine;
  abortSignal: AbortSignal;
  tracer?: Tracer;
}
~~~

AgentLoop.runToolCalls() 创建 ToolContext 时传 tracer: this.tracer。

- [ ] **Step 2: 创建 Skill Span 助手**

~~~ts
import type { TraceEventName } from "@dkagent/trace";
import type { ToolContext } from "../tools/types.js";

export async function observeSkillOperation<T>(input: {
  context: ToolContext;
  name: Extract<TraceEventName, "skill.run" | "skill.stage">;
  operation: string;
  traceInput: unknown;
  execute: () => Promise<T>;
  summarizeOutput: (value: T) => unknown;
}): Promise<T> {
  if (!input.context.tracer) return input.execute();
  return input.context.tracer.span(
    input.name,
    input.traceInput,
    async (span) => {
      const value = await input.execute();
      span.setOutput(input.summarizeOutput(value));
      return value;
    },
    { module: "skill", operation: input.operation },
  );
}
~~~

- [ ] **Step 3: 记录 queryModelJson**

输入增加 tracer?: Tracer 和 traceOperation: string。实际请求保持原样，Trace 请求不含 abortSignal 和回调。

~~~ts
const execute = async (span?: TraceSpan): Promise<T> => {
  const response = await input.queryEngine.query(request);
  span?.event("model.response", response);
  span?.setOutput(response);
  if (response.type !== "text") throw new Error("结构化任务未返回文本");
  const content = response.content
    .replace(/^\x60{3}(?:json)?\s*/i, "")
    .replace(/\s*\x60{3}$/, "");
  return input.schema.parse(JSON.parse(content));
};

return input.tracer
  ? input.tracer.span(
      "model.request",
      traceRequest,
      execute,
      { module: "skill", operation: input.traceOperation },
    )
  : execute();
~~~

响应必须在 JSON/Zod 解析前发布。

- [ ] **Step 4: 标记所有模型 operation**

| 文件 | traceOperation |
|---|---|
| preprocess-transcript.ts | preprocess_transcript |
| structurer.ts | structure_interview |
| extract-project-facts.ts | extract_project_facts |
| analyze-expression.ts | analyze_expression |
| analyze-answer.ts | analyze_answer |
| generate-report.ts 总结 | generate_report_summary |
| generate-report.ts JD | evaluate_job_match |

每处传 tracer: ctx.tracer。StructureInput 增加 tracer?: Tracer，由 diagnose-transcript 传 context.tracer。

- [ ] **Step 5: 记录 Skill Run 和阶段**

整个 diagnose-transcript 实际流程由 skill.run 包裹，operation=diagnose-transcript。异常先形成 skill.run error，再由原有 catch 转为 ToolResult。

阶段使用 observeSkillOperation()：

| operation | traceInput | summarizeOutput |
|---|---|---|
| read_transcript | transcriptPath | path、characterCount |
| preprocess_transcript | turnCount | success、correctionCount |
| structure_interview | turnCount | clusterCount、questionCount |
| extract_project_facts | clusterId、questionCount | success、factCount |
| analyze_expression | questionId | success、judgementStatus |
| retrieve_reference | questionId | referenceCount |
| analyze_answer | questionId、clusterId | success、analysisStatus |
| generate_report | questionCount、hasJd | success、summaryStatus、jobMatchStatus |
| write_report | transcriptPath | reportPath、characterCount |

完整调用范式：

~~~ts
const source = await observeSkillOperation({
  context,
  name: "skill.stage",
  operation: "read_transcript",
  traceInput: { transcriptPath: input.transcriptPath },
  execute: () => readWholeText(deps.readFileTool, input.transcriptPath, context),
  summarizeOutput: (value) => ({
    path: value.path,
    characterCount: value.content.length,
  }),
});
~~~

其余阶段使用表中精确字段，不复制完整 transcript、analysis、reference 或 markdown。

- [ ] **Step 6: 补实现后集成测试**

现有真实 Registry 集成测试注入 MemoryTraceStore 和 Tracer。断言存在 skill.run、analyze_answer stage、8 对 model request/response，不存在内部 tool.call。再让 Fake Provider 返回非法 JSON，断言 model.response Event 已记录，随后同 Span 出现 model.request error。

- [ ] **Step 7: 验证并提交**

~~~bash
npm run test:interview -w @dkagent/agent
npm run typecheck:interview -w @dkagent/agent
npm run typecheck -w @dkagent/agent
git diff --check
git add packages/agent/src/tools/types.ts packages/agent/src/agent/loop.ts packages/agent/src/interview/model-json.ts packages/agent/src/interview/structurer.ts packages/agent/src/tools/tool-item/preprocess-transcript.ts packages/agent/src/tools/tool-item/extract-project-facts.ts packages/agent/src/tools/tool-item/analyze-expression.ts packages/agent/src/tools/tool-item/analyze-answer.ts packages/agent/src/tools/tool-item/generate-report.ts packages/agent/src/skills/skill-trace.ts packages/agent/src/skills/diagnose-transcript.ts packages/agent/test/interview/analyze-interview.integration.test.ts
git commit -m "feat(agent): trace skill stages and model calls"
~~~

Expected: Interview 测试、专项和完整 Agent 类型检查通过。

---

### Task 4: Web Tap 投影

**Files**

- Modify: packages/web-tap/src/web/model/types.ts
- Modify: packages/web-tap/src/web/model/project-events.ts
- Modify: packages/web-tap/src/web/features/node-detail/NodeDetail.tsx
- Modify: packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx
- Test: packages/web-tap/test/web/project-events.test.ts
- Test: packages/web-tap/test/web/agent-turn-analysis.test.ts
- Test: packages/web-tap/test/web/tap-app.test.tsx
- Modify: packages/web-tap/WEB-TAP.md

**Produces:** Memory/Skill 正式节点、中文标题、正确 Tag；模型总量包含内部调用。

- [ ] **Step 1: 增加节点类型**

TapNodeKind 追加 memory_operation、skill_operation；NodeDetail.nodeRenderers 都注册为 renderFields。

- [ ] **Step 2: 解析显式模块**

~~~ts
function moduleForTraceEvent(event: TraceEvent): TapModuleKind {
  return event.module ?? moduleForEvent(event.name);
}
~~~

保留 moduleForEvent() 兼容旧事件，eventNode() 改用新函数。

- [ ] **Step 3: 汉化 operation**

~~~ts
const operationLabels: Record<string, string> = {
  recall: "召回记忆",
  extract: "提取记忆",
  write: "写入记忆",
  persist: "持久化记忆",
  "diagnose-transcript": "分析面试记录",
  read_transcript: "读取并解析面试稿",
  preprocess_transcript: "纠错预处理",
  structure_interview: "构建问答结构",
  extract_project_facts: "提取项目事实",
  analyze_expression: "分析表达",
  retrieve_reference: "检索参考资料",
  analyze_answer: "分析回答",
  generate_report: "生成分析报告",
  generate_report_summary: "生成报告总结",
  evaluate_job_match: "分析岗位匹配",
  write_report: "写入分析报告",
};
~~~

- [ ] **Step 4: 映射标题和状态**

memory.recall/extract/write 返回 memory_operation；skill.run/stage 返回 skill_operation。start=running，end/event=completed，error 使用对应 kind 和 error，不能降级 unknown。

跨模块模型标题：

~~~text
module=skill operation=analyze_answer → 分析回答 · 模型请求/响应
module=memory operation=extract → 提取记忆 · 模型请求/响应
无 module → 模型请求/响应
~~~

Memory 生命周期分别显示召回记忆、提取记忆、写入记忆及完成/结果/失败。

- [ ] **Step 5: 汉化详情字段**

FieldDescriptions 增加 operation、userInputCharacterCount、answerCharacterCount、characterCount、turnCount、clusterCount、questionCount、candidateCount、rejectedCount、savedCount、ignoredCount、failedCount、factCount、referenceCount、correctionCount、questionId、clusterId、reportPath 的中文标签。

- [ ] **Step 6: 补实现后测试**

project-events.test.ts 断言 Memory/Skill/内部模型节点不含 unknown，标题和 module 正确。

agent-turn-analysis.test.ts 构造主模型、Skill 模型、Memory 模型三组配对事件，断言 modelCallCount=3、输入 Token=60、输出 Token=15、model_pairs=passed。

tap-app.test.tsx 点击新节点，断言中文标题、模块 Tag、详情字段、Markdown 和 Raw JSON 入口可见。

- [ ] **Step 7: 更新 WEB-TAP.md**

当前能力增加 Memory 召回/提取/写入、Skill 阶段和内部模型调用；明确 Skill 内容完整、Memory 内容在 Agent 侧生成安全摘要。架构来源改为 Agent / Context / Tool / Memory / Skill。

- [ ] **Step 8: 验证并提交**

~~~bash
npm run test:web -w @dkagent/web-tap -- --run
npm run typecheck -w @dkagent/web-tap
npm run build -w @dkagent/web-tap
git diff --check
git add packages/web-tap/src/web/model/types.ts packages/web-tap/src/web/model/project-events.ts packages/web-tap/src/web/features/node-detail/NodeDetail.tsx packages/web-tap/src/web/features/node-detail/FieldDescriptions.tsx packages/web-tap/test/web/project-events.test.ts packages/web-tap/test/web/agent-turn-analysis.test.ts packages/web-tap/test/web/tap-app.test.tsx packages/web-tap/WEB-TAP.md
git commit -m "feat(web-tap): visualize memory and skill traces"
~~~

Expected: Web 测试、类型检查、build 通过；仅允许现有大 chunk warning。

---

### Task 5: 全量回归、真实 Tap 和审核

**Files:** 不预设源文件；只有发现本次范围内缺陷时才做外科手术式修复。

- [ ] **Step 1: 全量自动验证**

~~~bash
npm test -w @dkagent/trace
npm test -w @dkagent/agent
npm test -w @dkagent/web-tap
npm run typecheck
git diff --check
~~~

Expected: 三个 workspace 测试和全仓类型检查通过。既有环境失败必须报告真实命令与 scoped 结果，不能宣称全绿。

- [ ] **Step 2: 启动真实 Observe**

~~~bash
npm run observe
~~~

先完成普通对话，再输入：

~~~text
请分析绝对路径 /Users/xuxiaokang/apps/DKAgent/packages/agent/test/fixtures/labeled-interview.txt 的面试记录
~~~

- [ ] **Step 3: 页面验收**

确认 Memory 不再未知；Skill 展示关键阶段；Skill 模型展示真实输入输出；Memory 模型显示 Token、type/key 与脱敏标记；Tool 数量未被内部阶段放大；Raw JSON、Session、Turn、Step、指标仍可用。

- [ ] **Step 4: 隐私检查**

从当前 Session 历史 API 与 SSE 各捕获一份事件到系统临时目录，搜索 MEMORY_INPUT_REDACTED、MEMORY_CONTENT_REDACTED 应命中；搜索本轮真实用户输入、回答和候选 content 应无匹配。临时文件不得加入 Git。

- [ ] **Step 5: 审核边界**

确认新增 Agent 字段只是可选运行依赖；Memory 原文未进入 tracer.span/event/setOutput；Skill 模型成对且 parentSpanId 正确；没有全局修改 QueryEngine、伪造内部 Tool、样式或数据库改动；用户文件未暂存。

- [ ] **Step 6: 处理审核结果**

若无缺陷，不创建空提交。若发现缺陷，只修改命中问题的本次文件，重新运行受影响专项与全量验证，并使用提交信息：

~~~bash
git commit -m "fix(trace): address memory skill review"
~~~
