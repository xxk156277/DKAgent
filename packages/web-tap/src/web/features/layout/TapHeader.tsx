import { Badge, Button, Typography } from "antd";
import type { TapState } from "../../store/tap-store.js";

const connectionLabels: Record<TapState["connectionStatus"], string> = {
  connecting: "连接中",
  live: "实时观察",
  reconnecting: "正在重连",
  error: "连接异常",
};

interface TapHeaderProps {
  connectionStatus: TapState["connectionStatus"];
  mobile: boolean;
  attentionCount: number;
  onOpenTurns(): void;
  onOpenInsights(): void;
}

export function TapHeader({
  connectionStatus,
  mobile,
  attentionCount,
  onOpenTurns,
  onOpenInsights,
}: TapHeaderProps) {
  return (
    <header className="tap-product-header">
      <div className="tap-brand">
        <span className="tap-brand-mark" aria-hidden="true">DK</span>
        <Typography.Text strong>DKAgent Tap</Typography.Text>
      </div>
      {mobile ? (
        <div className="tap-mobile-actions">
          <Button
            type="text"
            aria-label="打开对话轮次"
            onClick={(event) => {
              event.currentTarget.focus();
              onOpenTurns();
            }}
          >
            对话
          </Button>
          <Badge count={attentionCount} size="small">
            <Button
              type="text"
              aria-label="打开 Agent 指标"
              onClick={(event) => {
                event.currentTarget.focus();
                onOpenInsights();
              }}
            >
              指标
            </Button>
          </Badge>
        </div>
      ) : null}
      <span className={`tap-connection is-${connectionStatus}`} aria-live="polite">
        <span className="tap-connection-dot" aria-hidden="true" />
        {connectionLabels[connectionStatus]}
      </span>
    </header>
  );
}
