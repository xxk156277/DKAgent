import type {
  AssertionValueFunctionContext,
  GradingResult,
} from "promptfoo";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  workspaceRoot?: string;
  runError?: { stage: "setup" | "model" | "agent" | "capture" | "cleanup"; message: string };
  finalFiles?: Record<string, string>;
}

export interface AgentAssertionConfig {
  requiredTools?: string[];
  expectedToolPaths?: Record<string, string>;
  forbiddenTools?: string[];
  outputIncludes?: string;
  requireNoTools?: boolean;
  mustHappenBefore?: {
    before: { tool: string; path: string };
    after: { tool: string; path: string };
  };
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

function isWithinDirectory(directory: string, candidate: string, allowSame = true): boolean {
  if (!isAbsolute(directory) || !isAbsolute(candidate)) return false;
  const path = relative(resolve(directory), resolve(candidate));
  if (path === "") return allowSame;
  return path !== ".."
    && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

function resolveWorkspacePath(
  workspaceRoot: unknown,
  value: unknown,
  allowSame = false,
): string | undefined {
  if (typeof workspaceRoot !== "string" || !isAbsolute(workspaceRoot) || typeof value !== "string") {
    return undefined;
  }
  const root = resolve(workspaceRoot);
  const platformPath = value.replaceAll("\\", sep);
  const candidate = isAbsolute(platformPath)
    ? resolve(platformPath)
    : resolve(root, platformPath);
  return isWithinDirectory(root, candidate, allowSame) ? candidate : undefined;
}

function resultPathInWorkspace(workspaceRoot: unknown, resultPath: unknown): string | undefined {
  return resolveWorkspacePath(workspaceRoot, resultPath, true);
}

function workspaceRelativeFile(
  workspaceRoot: string,
  resultPath: string,
  file: string,
): string | undefined {
  const candidate = resolve(resultPath, file);
  if (!isWithinDirectory(workspaceRoot, candidate, false)) return undefined;
  return normalizePath(relative(resolve(workspaceRoot), candidate));
}

interface EvalGrepMatch {
  path: string;
  line: number;
  text: string;
}

function isGrepMatch(value: unknown): value is EvalGrepMatch {
  const match = record(value);
  return match !== undefined
    && typeof match.path === "string"
    && typeof match.line === "number"
    && Number.isInteger(match.line)
    && match.line > 0
    && typeof match.text === "string";
}

function hasExactFindFiles(
  results: ReturnType<typeof selectToolResults>,
  expected: string[],
  workspaceRoot: unknown,
): boolean {
  const result = results.find((item) => item.name === "find_files" && item.result.success);
  const data = record(result?.result.data);
  const files = data?.files;
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === "string")) {
    return false;
  }
  if (typeof workspaceRoot !== "string") return false;
  const path = resultPathInWorkspace(workspaceRoot, data?.path);
  if (path === undefined) return false;
  const actual = files.map((file) => workspaceRelativeFile(workspaceRoot, path, file));
  if (actual.some((file): file is undefined => file === undefined)) return false;
  const wanted = expected.map(normalizePath).sort();
  actual.sort();
  return actual.length === wanted.length && actual.every((file, index) => file === wanted[index]);
}

function hasExpectedGrep(
  results: ReturnType<typeof selectToolResults>,
  expected: NonNullable<AgentAssertionConfig["expectedGrep"]>,
  workspaceRoot: unknown,
): boolean {
  const result = results.find((item) => item.name === "grep_files" && item.result.success);
  const data = record(result?.result.data);
  if (resultPathInWorkspace(workspaceRoot, data?.path) === undefined) return false;
  const matches = data?.matches;
  if (!Array.isArray(matches) || !matches.every(isGrepMatch)) return false;
  return matches.some((item) => {
    return normalizePath(item.path) === normalizePath(expected.path)
      && item.text.includes(expected.text);
  });
}

function hasExpectedToolPaths(
  calls: ReturnType<typeof selectToolCalls>,
  results: ReturnType<typeof selectToolResults>,
  expected: Record<string, string>,
  workspaceRoot: unknown,
): boolean {
  return Object.entries(expected).every(([name, expectedPath]) => {
    const target = resolveWorkspacePath(workspaceRoot, expectedPath);
    if (target === undefined) return false;
    const matchingCalls = calls.filter((call) => call.name === name);
    if (matchingCalls.length === 0) return false;
    return matchingCalls.every((call) => {
      const result = results.find((item) => item.toolCallId === call.id);
      return result !== undefined
        && result.name === call.name
        && resolveWorkspacePath(workspaceRoot, call.input.path) === target
        && resolveWorkspacePath(workspaceRoot, result.input.path) === target;
    });
  });
}

function hasRequiredCausalOrder(
  calls: ReturnType<typeof selectToolCalls>,
  results: ReturnType<typeof selectToolResults>,
  expected: NonNullable<AgentAssertionConfig["mustHappenBefore"]>,
  workspaceRoot: unknown,
): boolean {
  const orderedCalls = [...calls].sort((left, right) => left.sequence - right.sequence);
  const beforePath = resolveWorkspacePath(workspaceRoot, expected.before.path);
  const afterPath = resolveWorkspacePath(workspaceRoot, expected.after.path);
  if (beforePath === undefined || afterPath === undefined) return false;
  const hasSuccessfulResult = (
    call: (typeof orderedCalls)[number],
    targetPath: string,
  ): boolean => {
    const result = results.find((item) => item.toolCallId === call.id);
    return result !== undefined
      && result.name === call.name
      && result.result.success === true
      && resolveWorkspacePath(workspaceRoot, result.input.path) === targetPath;
  };
  const firstAfter = orderedCalls.find((call) => (
    call.name === expected.after.tool
    && typeof call.input.path === "string"
    && resolveWorkspacePath(workspaceRoot, call.input.path) === afterPath
    && hasSuccessfulResult(call, afterPath)
  ));
  if (firstAfter === undefined) return false;
  return orderedCalls.some((call) => (
    call.sequence < firstAfter.sequence
    && call.name === expected.before.tool
    && typeof call.input.path === "string"
    && resolveWorkspacePath(workspaceRoot, call.input.path) === beforePath
    && hasSuccessfulResult(call, beforePath)
  ));
}

function finalFileMismatches(
  actual: unknown,
  expected: Record<string, string>,
): string[] {
  const files = record(actual);
  return Object.entries(expected).flatMap(([name, content]) => {
    if (files === undefined || !Object.hasOwn(files, name)) {
      return [`缺少最终文件: ${name}`];
    }
    return files[name] === content ? [] : [`最终文件内容不匹配: ${name}`];
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
  if (config.expectedToolPaths !== undefined) {
    components.push(component(
      "expectedToolPaths",
      hasExpectedToolPaths(calls, results, config.expectedToolPaths, metadata.workspaceRoot),
      "必要 Tool 的 Call 与 Result 均指向 workspace 内的精确路径",
    ));
  }
  if (config.expectedFindFiles !== undefined) {
    components.push(component(
      "expectedFindFiles",
      hasExactFindFiles(results, config.expectedFindFiles, metadata.workspaceRoot),
      "find_files 返回精确文件集合",
    ));
  }
  if (config.expectedGrep !== undefined) {
    components.push(component(
      "expectedGrep",
      hasExpectedGrep(results, config.expectedGrep, metadata.workspaceRoot),
      "grep_files 返回包含目标路径和文本的匹配",
    ));
  }
  if (config.mustHappenBefore !== undefined) {
    const { before, after } = config.mustHappenBefore;
    components.push(component(
      "mustHappenBefore",
      hasRequiredCausalOrder(calls, results, config.mustHappenBefore, metadata.workspaceRoot),
      `要求 ${before.tool}(${before.path}) 先于首次 ${after.tool}(${after.path})`,
    ));
  }
  if (config.expectedFinalFiles !== undefined) {
    const mismatches = finalFileMismatches(metadata.finalFiles, config.expectedFinalFiles);
    components.push(component(
      "expectedFinalFiles",
      mismatches.length === 0,
      mismatches.length === 0 ? "最终文件内容与预期完全一致" : mismatches.join("; "),
    ));
  }
  const pass = components.every((item) => item.pass);
  return { pass, score: pass ? 1 : 0, reason: pass ? "全部组件通过" : "存在失败组件", componentResults: components };
}
