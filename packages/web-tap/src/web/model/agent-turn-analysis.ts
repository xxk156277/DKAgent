import type { TraceEvent } from "@dkagent/trace";
import type {
  AgentEvaluationItem,
  AgentTurnAnalysis,
  AgentTurnMetrics,
  TapTurnView,
} from "./types.js";

export function analyzeAgentTurn(turn: TapTurnView): AgentTurnAnalysis {
  const events = turn.rawEvents;
  const turnError = events.find((event) => event.name === "agent.turn" && event.phase === "error");
  const turnEnd = [...events].reverse().find((event) => event.name === "agent.turn" && event.phase === "end");
  const status = turnError ? "error" : turnEnd ? "completed" : "running";
  const modelRequests = events.filter((event) =>
    (event.name === "model.request" || event.name === "context.summary.request") && event.phase === "start");
  const modelResponses = events.filter((event) =>
    (event.name === "model.response" || event.name === "context.summary.response") && event.phase === "event");
  const toolCalls = events.filter((event) => event.name === "tool.call" && event.phase === "start");
  const toolResults = events.filter((event) => event.name === "tool.result" && event.phase === "event");
  const compactions = events.filter((event) => event.name === "context.compaction.completed" && event.phase === "event");
  const stepCount = countSteps(turn);
  const usage = readCompleteUsage(modelResponses);
  const toolSuccess = readToolSuccess(toolCalls, toolResults);
  const latestCompaction = readCompaction(compactions.at(-1));
  const terminal = turnError ?? turnEnd;

  const metrics: AgentTurnMetrics = {
    status,
    ...(terminal?.durationMs === undefined ? {} : { durationMs: terminal.durationMs }),
    stepCount,
    modelCallCount: modelRequests.length + countLegacyCombinedResponses(modelResponses),
    toolCallCount: toolCalls.length,
    ...(toolSuccess === undefined ? {} : { successfulToolCallCount: toolSuccess.successCount }),
    ...(usage === undefined ? {} : usage),
    compactionCount: compactions.length,
    ...(latestCompaction === undefined ? {} : { latestCompaction }),
  };

  return {
    metrics,
    evaluations: [
      evaluateTurnStatus(status, terminal),
      evaluateModelPairs(status, modelRequests, modelResponses),
      evaluateToolPairs(status, toolCalls, toolResults),
      evaluateToolResults(toolCalls, toolResults, toolSuccess),
      evaluateLoop(status, turnError, stepCount),
      evaluateCompaction(latestCompaction, compactions),
      unknown("hallucination", "幻觉", "待评测：需要外部事实依据或参考答案"),
      unknown("compaction_fidelity", "压缩语义保真度", "待评测：需要比较原始上下文与压缩结果的关键信息"),
      unknown("answer_quality", "最终答案质量", "待评测：需要参考答案、人工评价或独立评测器"),
    ],
  };
}

function countSteps(turn: TapTurnView): number {
  const steps = new Set(turn.rawEvents
    .filter((event) => event.name === "agent.step" && event.phase === "start")
    .map((event) => event.step)
    .filter((step): step is number => step !== undefined));
  return steps.size > 0 ? steps.size : turn.steps.length;
}

function countLegacyCombinedResponses(events: TraceEvent[]): number {
  return events.filter((event) => {
    const data = unwrapData(event.data);
    return isRecord(data) && "request" in data && "response" in data;
  }).length;
}

function readCompleteUsage(events: TraceEvent[]): Pick<AgentTurnMetrics, "inputTokens" | "outputTokens"> | undefined {
  if (events.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    const response = readModelResponse(event);
    const usage = isRecord(response) ? response.usage : undefined;
    if (!isRecord(usage)
      || typeof usage.inputTokens !== "number"
      || typeof usage.outputTokens !== "number") return undefined;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return { inputTokens, outputTokens };
}

function readToolSuccess(
  calls: TraceEvent[],
  results: TraceEvent[],
): { successCount: number } | undefined {
  if (calls.length === 0) return undefined;
  const resultsById = new Map(results.map((event) => [readToolResultId(event), event]));
  let successCount = 0;
  for (const call of calls) {
    const callId = readToolCallId(call);
    const result = callId === undefined ? undefined : resultsById.get(callId);
    const success = readToolResultSuccess(result);
    if (success === undefined) return undefined;
    if (success) successCount += 1;
  }
  return { successCount };
}

function readCompaction(event: TraceEvent | undefined): AgentTurnMetrics["latestCompaction"] {
  if (!event) return undefined;
  const data = unwrapData(event.data);
  if (!isRecord(data)
    || typeof data.tokensBefore !== "number"
    || typeof data.tokensAfter !== "number"
    || typeof data.savedRatio !== "number") return undefined;
  return {
    tokensBefore: data.tokensBefore,
    tokensAfter: data.tokensAfter,
    savedRatio: data.savedRatio,
  };
}

function evaluateTurnStatus(
  status: AgentTurnMetrics["status"],
  terminal: TraceEvent | undefined,
): AgentEvaluationItem {
  if (status === "completed") {
    return item("turn_status", "Turn 完成状态", "passed", "本轮已正常结束", terminal ? [terminal.id] : []);
  }
  if (status === "error") {
    return item("turn_status", "Turn 完成状态", "failed", readErrorMessage(terminal) ?? "本轮执行失败", terminal ? [terminal.id] : []);
  }
  return item("turn_status", "Turn 完成状态", "unknown", "本轮仍在运行，尚不能判断是否完成", []);
}

function evaluateModelPairs(
  status: AgentTurnMetrics["status"],
  requests: TraceEvent[],
  responses: TraceEvent[],
): AgentEvaluationItem {
  const legacy = responses.filter(isLegacyCombinedResponse);
  const directResponses = responses.filter((event) => !isLegacyCombinedResponse(event));
  const requestSpanIds = new Set(requests.map((event) => event.spanId).filter((id): id is string => id !== undefined));
  const responseSpanIds = new Set(directResponses.map((event) => event.spanId).filter((id): id is string => id !== undefined));
  const missing = requests.filter((event) => event.spanId === undefined || !responseSpanIds.has(event.spanId));
  const orphan = directResponses.filter((event) => event.spanId === undefined || !requestSpanIds.has(event.spanId));
  const evidence = [...requests, ...responses].map((event) => event.id);

  if (requests.length === 0 && legacy.length === 0) {
    return item("model_pairs", "模型调用完整性", "unknown", "未记录可配对的模型请求", evidence);
  }
  if (missing.length === 0 && orphan.length === 0) {
    return item("model_pairs", "模型调用完整性", "passed", "模型请求和响应完整配对", evidence);
  }
  return item(
    "model_pairs",
    "模型调用完整性",
    status === "running" ? "unknown" : "failed",
    status === "running" ? "本轮仍在运行，模型调用尚未完整" : "存在未配对的模型请求或响应",
    evidence,
  );
}

function evaluateToolPairs(
  status: AgentTurnMetrics["status"],
  calls: TraceEvent[],
  results: TraceEvent[],
): AgentEvaluationItem {
  const callIds = new Set(calls.map(readToolCallId).filter((id): id is string => id !== undefined));
  const resultIds = new Set(results.map(readToolResultId).filter((id): id is string => id !== undefined));
  const incomplete = calls.some((event) => {
    const id = readToolCallId(event);
    return id === undefined || !resultIds.has(id);
  }) || results.some((event) => {
    const id = readToolResultId(event);
    return id === undefined || !callIds.has(id);
  });
  const evidence = [...calls, ...results].map((event) => event.id);

  if (calls.length === 0 && results.length === 0) {
    return item("tool_pairs", "Tool 链完整性", "unknown", "本轮未调用 Tool", []);
  }
  if (!incomplete) {
    return item("tool_pairs", "Tool 链完整性", "passed", "Tool Call 和 Result 完整配对", evidence);
  }
  return item(
    "tool_pairs",
    "Tool 链完整性",
    status === "running" ? "unknown" : "failed",
    status === "running" ? "本轮仍在运行，Tool 链尚未完整" : "存在缺失或孤立的 Tool Result",
    evidence,
  );
}

function evaluateToolResults(
  calls: TraceEvent[],
  results: TraceEvent[],
  success: { successCount: number } | undefined,
): AgentEvaluationItem {
  const evidence = [...calls, ...results].map((event) => event.id);
  if (calls.length === 0) {
    return item("tool_results", "Tool 执行结果", "unknown", "本轮未调用 Tool", []);
  }
  if (!success) {
    return item("tool_results", "Tool 执行结果", "unknown", "Tool 成功状态未完整记录", evidence);
  }
  if (success.successCount !== calls.length) {
    return item("tool_results", "Tool 执行结果", "failed", `${calls.length - success.successCount} 个 Tool 调用明确失败`, evidence);
  }
  return item("tool_results", "Tool 执行结果", "passed", "所有 Tool 调用均明确成功", evidence);
}

function evaluateLoop(
  status: AgentTurnMetrics["status"],
  error: TraceEvent | undefined,
  stepCount: number,
): AgentEvaluationItem {
  const message = readErrorMessage(error);
  if (message?.includes("超出最大循环次数")) {
    return item("loop_efficiency", "循环效率", "failed", message, error ? [error.id] : []);
  }
  if (status === "completed") {
    return item("loop_efficiency", "循环效率", "passed", `本轮在 ${stepCount} 个 Step 内完成；不判断该路径是否最优`, []);
  }
  return item("loop_efficiency", "循环效率", "unknown", "当前证据不足以判断循环效率", error ? [error.id] : []);
}

function evaluateCompaction(
  latest: AgentTurnMetrics["latestCompaction"],
  events: TraceEvent[],
): AgentEvaluationItem {
  const evidence = events.map((event) => event.id);
  if (events.length === 0) {
    return item("context_compaction", "Context 压缩结果", "unknown", "本轮未触发 Context 压缩", []);
  }
  if (!latest) {
    return item("context_compaction", "Context 压缩结果", "unknown", "压缩前后 Token 未完整记录", evidence);
  }
  if (latest.tokensAfter < latest.tokensBefore) {
    return item("context_compaction", "Context 压缩结果", "passed", `Token 从 ${latest.tokensBefore} 降至 ${latest.tokensAfter}；不代表语义一定完整`, evidence);
  }
  return item("context_compaction", "Context 压缩结果", "warning", "压缩后 Token 没有下降，需要检查压缩过程", evidence);
}

function unknown(id: string, label: string, summary: string): AgentEvaluationItem {
  return item(id, label, "unknown", summary, []);
}

function item(
  id: string,
  label: string,
  status: AgentEvaluationItem["status"],
  summary: string,
  evidenceEventIds: string[],
): AgentEvaluationItem {
  return { id, label, status, summary, evidenceEventIds };
}

function isLegacyCombinedResponse(event: TraceEvent): boolean {
  const data = unwrapData(event.data);
  return isRecord(data) && "request" in data && "response" in data;
}

function readModelResponse(event: TraceEvent): unknown {
  const data = unwrapData(event.data);
  return isRecord(data) && "response" in data ? data.response : data;
}

function readToolCallId(event: TraceEvent): string | undefined {
  const data = unwrapData(event.data);
  return isRecord(data) && typeof data.id === "string" ? data.id : undefined;
}

function readToolResultId(event: TraceEvent): string | undefined {
  const data = unwrapData(event.data);
  return isRecord(data) && typeof data.toolCallId === "string" ? data.toolCallId : undefined;
}

function readToolResultSuccess(event: TraceEvent | undefined): boolean | undefined {
  if (!event) return undefined;
  const data = unwrapData(event.data);
  const result = isRecord(data) ? data.result : undefined;
  return isRecord(result) && typeof result.success === "boolean" ? result.success : undefined;
}

function readErrorMessage(event: TraceEvent | undefined): string | undefined {
  const data = event ? unwrapData(event.data) : undefined;
  const error = isRecord(data) ? data.error : undefined;
  return isRecord(error) && typeof error.message === "string" ? error.message : undefined;
}

function unwrapData(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if (Object.keys(data).length === 1 && "input" in data) return data.input;
  if (Object.keys(data).length === 1 && "output" in data) return data.output;
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
