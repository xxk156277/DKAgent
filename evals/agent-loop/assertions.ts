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
