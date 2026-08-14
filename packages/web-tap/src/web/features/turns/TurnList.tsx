import { Empty, List, Typography } from "antd";
import { summarizeTurn } from "../../model/turn-summary.js";
import type { TapTurnView } from "../../model/types.js";

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
