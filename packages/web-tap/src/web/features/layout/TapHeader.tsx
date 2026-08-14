import { Typography } from "antd";
import type { TapState } from "../../store/tap-store.js";

const connectionLabels: Record<TapState["connectionStatus"], string> = {
  connecting: "连接中",
  live: "实时观察",
  reconnecting: "正在重连",
  error: "连接异常",
};

export function TapHeader({ connectionStatus }: {
  connectionStatus: TapState["connectionStatus"];
}) {
  return (
    <header className="tap-product-header">
      <div className="tap-brand">
        <span className="tap-brand-mark" aria-hidden="true">DK</span>
        <Typography.Text strong>DKAgent Tap</Typography.Text>
      </div>
      <span className={`tap-connection is-${connectionStatus}`} aria-live="polite">
        <span className="tap-connection-dot" aria-hidden="true" />
        {connectionLabels[connectionStatus]}
      </span>
    </header>
  );
}
