import type { RuntimeEvent } from "@dkagent/agent/runtime-events";

export type TapNodeKind =
  | "turn_start"
  | "context_before"
  | "context_after"
  | "context_trimmed"
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "turn_end"
  | "turn_error"
  | "unknown";

export interface TapNodeView {
  id: string;
  kind: TapNodeKind;
  title: string;
  eventType: string;
  status: "running" | "completed" | "error";
  eventIds: string[];
  detail: unknown;
  rawEvents: RuntimeEvent[];
}

export interface TapStepView {
  step: number;
  nodes: TapNodeView[];
}

export interface TapTurnView {
  id: string;
  steps: TapStepView[];
}

export interface TapSessionView {
  id: string;
  turns: TapTurnView[];
}

/** 上下文裁剪时必须一起展示的消息组。 */
export interface ContextDiffGroup {
  kind: "single" | "tool_exchange";
  messages: unknown[];
}

export interface ContextDiff {
  before: unknown[];
  after: unknown[];
  removedGroups: ContextDiffGroup[];
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedInputTokens?: number;
  afterEstimatedInputTokens?: number;
  beforeAvailableInputTokens?: number;
  afterAvailableInputTokens?: number;
  beforeMaxContextTokens?: number;
  afterMaxContextTokens?: number;
  beforeReservedOutputTokens?: number;
  afterReservedOutputTokens?: number;
}
