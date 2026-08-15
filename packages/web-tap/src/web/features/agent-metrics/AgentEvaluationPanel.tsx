import { Card, List, Tag, Typography } from "antd";
import type { AgentEvaluationItem, AgentEvaluationStatus } from "../../model/types.js";

interface AgentEvaluationPanelProps {
  items: AgentEvaluationItem[];
}

const statusView: Record<AgentEvaluationStatus, { color: string; label: string }> = {
  passed: { color: "success", label: "通过" },
  warning: { color: "warning", label: "需关注" },
  failed: { color: "error", label: "失败" },
  unknown: { color: "default", label: "待评测" },
};

const pendingEvaluationIds = new Set([
  "hallucination",
  "compaction_fidelity",
  "answer_quality",
]);

export function AgentEvaluationPanel({ items }: AgentEvaluationPanelProps) {
  const traceRuleItems = items.filter((item) => !pendingEvaluationIds.has(item.id));
  const pendingItems = items.filter((item) => pendingEvaluationIds.has(item.id));

  return (
    <section aria-label="Agent 轨迹评价">
      <Card className="tap-agent-evaluation" size="small" title="Agent 轨迹评价">
        <section aria-label="规则判断（基于 Trace）">
          <Typography.Title level={5}>规则判断（基于 Trace）</Typography.Title>
          <List dataSource={traceRuleItems} rowKey="id" renderItem={renderEvaluationItem} />
        </section>
        <section aria-label="待评测（需要外部证据）">
          <Typography.Title level={5}>待评测（需要外部证据）</Typography.Title>
          <List dataSource={pendingItems} rowKey="id" renderItem={renderEvaluationItem} />
        </section>
      </Card>
    </section>
  );
}

function renderEvaluationItem(item: AgentEvaluationItem) {
  const view = statusView[item.status];
  return (
    <List.Item className="tap-evaluation-item">
      <div className="tap-evaluation-heading">
        <Typography.Text strong>{item.label}</Typography.Text>
        <Tag color={view.color}>{view.label}</Tag>
      </div>
      <Typography.Text type="secondary">{item.summary}</Typography.Text>
    </List.Item>
  );
}
