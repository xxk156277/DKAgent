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

export function AgentEvaluationPanel({ items }: AgentEvaluationPanelProps) {
  return (
    <section aria-label="Agent 轨迹评价">
      <Card className="tap-agent-evaluation" size="small" title="Agent 轨迹评价">
        <List
          dataSource={items}
          rowKey="id"
          renderItem={(item) => {
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
          }}
        />
      </Card>
    </section>
  );
}
