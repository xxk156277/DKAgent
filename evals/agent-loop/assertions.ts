import type {
  AssertionValueFunctionContext,
  GradingResult,
} from "promptfoo";
import type { TraceEvent } from "@dkagent/trace";
import {
  findToolProtocolViolations,
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

function component(name: string, pass: boolean, reason: string): GradingResult {
  return {
    pass,
    score: pass ? 1 : 0,
    reason,
    metadata: { component: name },
  };
}

export function gradeAgentRun(
  output: string,
  context: AssertionValueFunctionContext,
): GradingResult {
  const config = (context.config ?? {}) as AgentAssertionConfig;
  const metadata = context.providerResponse?.metadata?.evalRun as
    | AgentEvalRunMetadata
    | undefined;
  if (!metadata) {
    return {
      pass: false,
      score: 0,
      reason: "Provider 未返回 evalRun metadata",
      componentResults: [
        component("runError", false, "Provider 未返回 evalRun metadata"),
        component("requiredTool", false, "Provider 未返回 evalRun metadata"),
        component("requiredToolResult", false, "Provider 未返回 evalRun metadata"),
        component("protocolIntegrity", false, "Provider 未返回 evalRun metadata"),
        component("outputIncludes", false, "Provider 未返回 evalRun metadata"),
        component("termination", false, "Provider 未返回 evalRun metadata"),
      ],
    };
  }

  const calls = selectToolCalls(metadata.traceEvents);
  const results = selectToolResults(metadata.traceEvents);
  const requiredTools = config.requiredTools ?? [];
  const protocolViolations = findToolProtocolViolations(metadata.traceEvents);
  const components: GradingResult[] = [
    component("runError", metadata.runError === undefined, metadata.runError?.message ?? "Agent Run 无错误"),
    component(
      "requiredTool",
      requiredTools.every((name) => calls.some((call) => call.name === name)),
      `必要 Tool: ${requiredTools.join(", ") || "无"}`,
    ),
    component(
      "requiredToolResult",
      requiredTools.every((name) => results.some((item) => item.name === name && item.result.success)),
      "必要 Tool Result 成功",
    ),
    component(
      "protocolIntegrity",
      protocolViolations.length === 0,
      protocolViolations.length === 0
        ? "Tool Call/Result 双向一对一配对"
        : protocolViolations.map((violation) => violation.message).join("; "),
    ),
    component(
      "outputIncludes",
      config.outputIncludes === undefined || output.includes(config.outputIncludes),
      config.outputIncludes === undefined ? "无需文本标记" : `回答包含 ${config.outputIncludes}`,
    ),
    component("termination", hasNormalTermination(metadata.traceEvents), "Agent 正常结束"),
  ];
  const pass = components.every((item) => item.pass);
  return { pass, score: pass ? 1 : 0, reason: pass ? "全部组件通过" : "存在失败组件", componentResults: components };
}
