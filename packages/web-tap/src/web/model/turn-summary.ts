import type { TapNodeView, TapTurnView } from "./types.js";

export interface TapTurnSummary {
  input: string;
  toolCount: number;
  status: TapNodeView["status"];
  statusLabel: "进行中" | "已完成" | "错误";
}

export function summarizeTurn(turn: TapTurnView): TapTurnSummary {
  const nodes = turn.steps.flatMap((step) => step.nodes);
  const root = turn.rawSpans.find((span) => span.name === "agent.turn" && span.parentSpanId === undefined);
  const input = root?.name === "agent.turn" ? root.input.userInput : "未记录输入";
  const status = turn.trace.status === "ok" ? "completed" : turn.trace.status;

  return {
    input,
    toolCount: nodes.filter((node) => node.kind === "tool.execute").length,
    status,
    statusLabel: status === "error" ? "错误" : status === "completed" ? "已完成" : "进行中",
  };
}
