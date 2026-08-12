import { Empty, List, Typography } from "antd";
import type { TapNodeView, TapTurnView } from "../../model/types.js";

interface TurnListProps {
  turns: TapTurnView[];
  selectedTurnId: string | null;
  connectionStatus: "connecting" | "live" | "reconnecting" | "error";
  onSelect(turnId: string): void;
}

const connectionLabels: Record<TurnListProps["connectionStatus"], string> = {
  connecting: "连接中",
  live: "实时",
  reconnecting: "正在重连",
  error: "连接异常",
};

/** 左栏只展示 Turn 投影，选择行为交给外部 Store。 */
export function TurnList({ turns, selectedTurnId, connectionStatus, onSelect }: TurnListProps) {
  return (
    <aside className="tap-region tap-turn-region" aria-labelledby="turn-list-heading">
      <header className="tap-region-header">
        <Typography.Title id="turn-list-heading" level={2}>对话轮次</Typography.Title>
        <Typography.Text aria-live="polite" type="secondary">
          连接状态：{connectionLabels[connectionStatus]}
        </Typography.Text>
      </header>
      <List
        className="tap-turn-list"
        dataSource={turns}
        locale={{
          emptyText: <Empty description="暂无对话轮次" image={Empty.PRESENTED_IMAGE_SIMPLE} />,
        }}
        rowKey="id"
        renderItem={(turn, index) => {
          const summary = summarizeTurn(turn);
          const selected = turn.id === selectedTurnId;
          return (
            <List.Item>
              <button
                type="button"
                className={`tap-turn-button${selected ? " is-selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(turn.id)}
              >
                <span className="tap-turn-title">第 {index + 1} 轮</span>
                <span className="tap-turn-input" title={summary.input}>{summary.input}</span>
                <span className="tap-turn-meta">
                  <span>{turn.steps.length} Step</span>
                  <span>{summary.toolCount} Tool</span>
                  <span className={`tap-turn-status is-${summary.status}`}>{summary.statusLabel}</span>
                </span>
              </button>
            </List.Item>
          );
        }}
      />
    </aside>
  );
}

function summarizeTurn(turn: TapTurnView): {
  input: string;
  toolCount: number;
  status: TapNodeView["status"];
  statusLabel: string;
} {
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
