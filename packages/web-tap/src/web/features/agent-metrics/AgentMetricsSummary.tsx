import { Card, Statistic } from "antd";
import type { AgentTurnMetrics } from "../../model/types.js";

interface AgentMetricsSummaryProps {
  metrics: AgentTurnMetrics;
}

const statusLabels = {
  running: "进行中",
  completed: "已完成",
  error: "失败",
} as const;

export function AgentMetricsSummary({ metrics }: AgentMetricsSummaryProps) {
  return (
    <section aria-label="Agent 运行指标">
      <Card className="tap-agent-metrics" size="small" title="Agent 运行指标">
        <div className="tap-metrics-grid">
          <Statistic title="状态" value={statusLabels[metrics.status]} />
          <Statistic title="总耗时" value={formatDuration(metrics.durationMs)} />
          <Statistic title="Step" value={metrics.stepCount} />
          <Statistic title="模型调用" value={metrics.modelCallCount} />
          <Statistic title="Tool 调用" value={formatToolCalls(metrics)} />
          <Statistic title="输入 / 输出 Token" value={formatTokens(metrics)} />
          <Statistic title="Context 压缩" value={formatCompaction(metrics)} />
        </div>
      </Card>
    </section>
  );
}

function formatDuration(durationMs: number | undefined): string {
  return durationMs === undefined ? "未记录" : `${durationMs} 毫秒`;
}

function formatToolCalls(metrics: AgentTurnMetrics): string {
  if (metrics.toolCallCount === 0) return "0 次";
  return metrics.successfulToolCallCount === undefined
    ? `${metrics.toolCallCount} 次，成功状态未记录`
    : `${metrics.successfulToolCallCount} / ${metrics.toolCallCount} 成功`;
}

function formatTokens(metrics: AgentTurnMetrics): string {
  return metrics.inputTokens === undefined || metrics.outputTokens === undefined
    ? "未记录"
    : `${metrics.inputTokens} / ${metrics.outputTokens}`;
}

function formatCompaction(metrics: AgentTurnMetrics): string {
  if (metrics.compactionCount === 0) return "未触发";
  const latest = metrics.latestCompaction;
  return latest === undefined
    ? `${metrics.compactionCount} 次，Token 未记录`
    : `${latest.tokensBefore} → ${latest.tokensAfter}（节省 ${(latest.savedRatio * 100).toFixed(1)}%）`;
}
