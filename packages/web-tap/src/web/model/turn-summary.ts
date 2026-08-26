import type { TapNodeView, TapTurnView } from "./types.js";

export interface TapTurnSummary {
    input: string;
    toolCount: number;
    status: TapNodeView["status"];
    statusLabel: "进行中" | "已完成" | "错误";
}

export function summarizeTurn(turn: TapTurnView): TapTurnSummary {
    const nodes = turn.steps.flatMap((step) => step.nodes);
    const start = nodes.find((node) => node.kind === "turn_start");
    const input = readStringField(start?.detail, "input") ?? "未记录输入";
    const hasError = nodes.some((node) => node.status === "error");
    const isCompleted = nodes.some((node) => node.kind === "turn_end");
    const status = hasError ? "error" : isCompleted ? "completed" : "running";

    return {
        input,
        toolCount: nodes.filter((node) => node.kind === "tool_call").length,
        status,
        statusLabel: status === "error" ? "错误" : status === "completed" ? "已完成" : "进行中",
    };
}

function readStringField(value: unknown, key: string): string | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : undefined;
}
