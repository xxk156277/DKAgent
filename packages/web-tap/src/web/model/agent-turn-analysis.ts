import type { AnyTraceSpan } from "@dkagent/trace";
import type { AgentEvaluationItem, AgentTurnAnalysis, AgentTurnMetrics, TapTurnView } from "./types.js";

export function analyzeAgentTurn(turn: TapTurnView): AgentTurnAnalysis {
  const spans = turn.rawSpans;
  const root = spans.find((span) => span.name === "agent.turn" && span.parentSpanId === undefined);
  const models = spans.filter((span) => span.name === "model.generate");
  const tools = spans.filter((span) => span.name === "tool.execute");
  const compactions = spans.filter((span) => span.name === "context.compact");
  const usage = sumUsage(models);
  const successfulTools = completeToolSuccess(tools);
  const latestCompaction = readCompaction(compactions.at(-1));
  const status = root?.status === "ok" ? "completed" : root?.status ?? "running";
  const integrityIssueCount = countIntegrityIssues(turn);

  const metrics: AgentTurnMetrics = {
    status,
    ...(root?.durationMs === undefined ? {} : { durationMs: root.durationMs }),
    stepCount: spans.filter((span) => span.name === "agent.step").length,
    modelCallCount: models.length,
    toolCallCount: tools.length,
    ...(successfulTools === undefined ? {} : { successfulToolCallCount: successfulTools }),
    ...(usage === undefined ? {} : usage),
    compactionCount: compactions.length,
    integrityIssueCount,
    ...(latestCompaction === undefined ? {} : { latestCompaction }),
  };

  return {
    metrics,
    evaluations: [
      evaluateTurn(status, root),
      evaluateIntegrity(turn, integrityIssueCount),
      evaluateTools(tools, successfulTools),
      pending("hallucination", "幻觉", "待评测：需要外部事实依据或参考答案"),
      pending("compaction_fidelity", "压缩语义保真度", "待评测：需要比较原始上下文与压缩结果的关键信息"),
      pending("answer_quality", "最终答案质量", "待评测：需要参考答案、人工评价或独立评测器"),
    ],
  };
}

function sumUsage(spans: AnyTraceSpan[]): Pick<AgentTurnMetrics, "inputTokens" | "outputTokens"> | undefined {
  if (spans.length === 0 || spans.some((span) => span.tokenUsage === null)) return undefined;
  return spans.reduce((total, span) => ({
    inputTokens: total.inputTokens + (span.tokenUsage?.inputTokens ?? 0),
    outputTokens: total.outputTokens + (span.tokenUsage?.outputTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0 });
}

function completeToolSuccess(spans: AnyTraceSpan[]): number | undefined {
  if (spans.length === 0) return undefined;
  let success = 0;
  for (const span of spans) {
    if (span.name !== "tool.execute" || span.output === null) return undefined;
    if (span.output.success) success += 1;
  }
  return success;
}

function readCompaction(span: AnyTraceSpan | undefined): AgentTurnMetrics["latestCompaction"] {
  if (span?.name !== "context.compact" || span.output === null) return undefined;
  const { tokensBefore, tokensAfter } = span.output;
  return {
    tokensBefore,
    tokensAfter,
    savedRatio: tokensBefore === 0 ? 0 : (tokensBefore - tokensAfter) / tokensBefore,
  };
}

function countIntegrityIssues(turn: TapTurnView): number {
  const diagnostics = turn.diagnostics;
  return (diagnostics.missingRoot ? 1 : 0)
    + new Set([
      ...diagnostics.missingParent,
      ...diagnostics.running,
      ...diagnostics.outputMissing,
      ...diagnostics.serializationError,
      ...turn.rawSpans.filter((span) => !span.integrity).map((span) => span.spanId),
    ]).size;
}

function evaluateTurn(status: AgentTurnMetrics["status"], root: AnyTraceSpan | undefined): AgentEvaluationItem {
  if (status === "completed") return item("turn_status", "Turn 完成状态", "passed", "本轮已正常结束", root ? [root.spanId] : []);
  if (status === "error") return item("turn_status", "Turn 完成状态", "failed", root?.error?.message ?? root?.error?.name ?? "本轮执行失败", root ? [root.spanId] : []);
  return item("turn_status", "Turn 完成状态", "unknown", "本轮仍在运行，尚不能判断是否完成", root ? [root.spanId] : []);
}

function evaluateIntegrity(turn: TapTurnView, issueCount: number): AgentEvaluationItem {
  if (turn.complete) return item("trace_integrity", "Trace 完整性", "passed", "Typed Span 链完整", turn.rawSpans.map((span) => span.spanId));
  if (turn.trace.status === "running") return item("trace_integrity", "Trace 完整性", "unknown", `运行中，当前有 ${issueCount} 项完整性诊断`, []);
  return item("trace_integrity", "Trace 完整性", "failed", `发现 ${issueCount} 项完整性问题`, []);
}

function evaluateTools(tools: AnyTraceSpan[], success: number | undefined): AgentEvaluationItem {
  if (tools.length === 0) return item("tool_results", "Tool 执行结果", "unknown", "本轮未调用 Tool", []);
  if (success === undefined) return item("tool_results", "Tool 执行结果", "unknown", "Tool 尚未全部结束", tools.map((span) => span.spanId));
  if (success === tools.length) return item("tool_results", "Tool 执行结果", "passed", "所有 Tool 调用均明确成功", tools.map((span) => span.spanId));
  return item("tool_results", "Tool 执行结果", "failed", `${tools.length - success} 个 Tool 调用明确失败`, tools.map((span) => span.spanId));
}

function pending(id: string, label: string, summary: string): AgentEvaluationItem {
  return item(id, label, "unknown", summary, []);
}

function item(
  id: string,
  label: string,
  status: AgentEvaluationItem["status"],
  summary: string,
  evidenceSpanIds: string[],
): AgentEvaluationItem {
  return { id, label, status, summary, evidenceSpanIds };
}
