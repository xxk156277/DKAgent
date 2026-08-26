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
  runError?: { stage: "setup" | "model" | "agent" | "capture" | "cleanup"; message: string };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function findFilesResultBase(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = normalizePath(value);
  const workspaceMarker = "/workspace";
  const markerIndex = normalized.lastIndexOf(workspaceMarker);
  const markerEnd = markerIndex + workspaceMarker.length;
  if (markerIndex >= 0 && (normalized.length === markerEnd || normalized[markerEnd] === "/")) {
    return normalized.slice(markerEnd).replace(/^\/+|\/+$/g, "");
  }
  return normalized === "." ? "" : normalized;
}

function hasExactFindFiles(results: ReturnType<typeof selectToolResults>, expected: string[]): boolean {
  const result = results.find((item) => item.name === "find_files" && item.result.success);
  const data = record(result?.result.data);
  const files = data?.files;
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === "string")) {
    return false;
  }
  const base = findFilesResultBase(data?.path);
  const actual = files.map((file) => {
    const normalizedFile = normalizePath(file);
    return base === "" ? normalizedFile : `${base}/${normalizedFile}`;
  }).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((file, index) => file === wanted[index]);
}

function hasExpectedGrep(
  results: ReturnType<typeof selectToolResults>,
  expected: NonNullable<AgentAssertionConfig["expectedGrep"]>,
): boolean {
  const result = results.find((item) => item.name === "grep_files" && item.result.success);
  const matches = record(result?.result.data)?.matches;
  if (!Array.isArray(matches)) return false;
  return matches.some((item) => {
    const match = record(item);
    return typeof match?.path === "string"
      && typeof match.text === "string"
      && match.path.includes(expected.path)
      && match.text.includes(expected.text);
  });
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
  if (config.requireNoTools === true) {
    components.push(component(
      "noTools",
      calls.length === 0,
      "要求不调用任何 Tool",
    ));
  }
  if (config.forbiddenTools !== undefined) {
    components.push(component(
      "forbiddenTools",
      config.forbiddenTools.every((name) => !calls.some((call) => call.name === name)),
      "未调用禁止的 Tool",
    ));
  }
  if (config.expectedFindFiles !== undefined) {
    components.push(component(
      "expectedFindFiles",
      hasExactFindFiles(results, config.expectedFindFiles),
      "find_files 返回精确文件集合",
    ));
  }
  if (config.expectedGrep !== undefined) {
    components.push(component(
      "expectedGrep",
      hasExpectedGrep(results, config.expectedGrep),
      "grep_files 返回包含目标路径和文本的匹配",
    ));
  }
  const pass = components.every((item) => item.pass);
  return { pass, score: pass ? 1 : 0, reason: pass ? "全部组件通过" : "存在失败组件", componentResults: components };
}
