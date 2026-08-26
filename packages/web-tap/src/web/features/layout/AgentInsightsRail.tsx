import LeftOutlined from "@ant-design/icons/LeftOutlined";
import RightOutlined from "@ant-design/icons/RightOutlined";
import { Badge, Button, Empty, Typography } from "antd";
import type { AgentTurnAnalysis } from "../../model/types.js";
import { AgentEvaluationPanel } from "../agent-metrics/AgentEvaluationPanel.js";
import { AgentMetricsSummary } from "../agent-metrics/AgentMetricsSummary.js";

export function AgentInsightsContent({ analysis }: { analysis?: AgentTurnAnalysis | undefined }) {
    if (!analysis) return <Empty description="暂无 Agent 指标" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

    return (
        <div className="tap-insights-content">
            <Typography.Text type="secondary">Agent 指标汇总当前 Turn，不随 Node 切换</Typography.Text>
            <AgentMetricsSummary metrics={analysis.metrics} />
            <AgentEvaluationPanel items={analysis.evaluations} />
        </div>
    );
}

export function AgentInsightsRail({
    analysis,
    collapsed,
    onToggle,
}: {
    analysis?: AgentTurnAnalysis | undefined;
    collapsed: boolean;
    onToggle(): void;
}) {
    const attentionCount =
        analysis?.evaluations.filter((item) => item.status === "warning" || item.status === "failed").length ?? 0;
    const toggle = (
        <Button
            type="text"
            icon={collapsed ? <LeftOutlined /> : <RightOutlined />}
            aria-label={collapsed ? "展开 Agent 指标" : "收起 Agent 指标"}
            aria-expanded={!collapsed}
            onClick={onToggle}
        />
    );

    return (
        <aside className={`tap-insights-rail${collapsed ? " is-collapsed" : ""}`} aria-label="Agent 指标">
            <header className="tap-insights-header">
                {collapsed ? (
                    <Badge className="tap-insights-toggle-badge" count={attentionCount} showZero size="small">
                        {toggle}
                    </Badge>
                ) : (
                    <Typography.Title level={2}>Agent 指标</Typography.Title>
                )}
                {collapsed ? null : toggle}
            </header>
            {collapsed ? null : <AgentInsightsContent analysis={analysis} />}
        </aside>
    );
}
