import CheckCircleFilled from "@ant-design/icons/CheckCircleFilled";
import ClockCircleFilled from "@ant-design/icons/ClockCircleFilled";
import CloseCircleFilled from "@ant-design/icons/CloseCircleFilled";
import { Collapse, Empty, Typography } from "antd";
import type { ReactNode } from "react";
import type { TapNodeView, TapTurnView } from "../../model/types.js";
import { ModuleTag } from "../../shared/ModuleTag.js";

interface NodeNavProps {
  turn: TapTurnView | undefined;
  turnIndex: number;
  selectedNodeId: string | null;
  onSelect(nodeId: string): void;
}

type DisplayStatus = "current" | "completed" | "error";

const statusPresentations: Record<DisplayStatus, { icon: ReactNode; label: string }> = {
  current: { icon: <ClockCircleFilled aria-hidden="true" />, label: "当前" },
  completed: { icon: <CheckCircleFilled aria-hidden="true" />, label: "已完成" },
  error: { icon: <CloseCircleFilled aria-hidden="true" />, label: "错误" },
};

/** 右栏保持 Step 层级，并让每一个 Node 都可独立选择。 */
export function NodeNav({ turn, turnIndex, selectedNodeId, onSelect }: NodeNavProps) {
  const heading = turn ? `第 ${turnIndex} 轮节点` : "节点导航";
  const nodeStates = turn ? deriveNodeStates(turn) : new Map<string, DisplayStatus>();
  return (
    <aside className="tap-region tap-node-region" aria-labelledby="node-navigation-heading">
      <header className="tap-region-header">
        <Typography.Title id="node-navigation-heading" level={2}>{heading}</Typography.Title>
      </header>
      {turn ? (
        <Collapse
          key={turn.id}
          className="tap-step-collapse"
          defaultActiveKey={turn.steps.map((step) => String(step.step))}
          items={turn.steps.map((step) => ({
            key: String(step.step),
            label: step.step === "turn" ? "Turn 级节点" : `Step ${step.step}`,
            children: (
              <div className="tap-node-list">
                {step.nodes.map((node) => (
                  <NodeButton
                    key={node.id}
                    node={node}
                    displayStatus={nodeStates.get(node.id) ?? "completed"}
                    selected={node.id === selectedNodeId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            ),
          }))}
        />
      ) : (
        <Empty description="暂无可导航节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </aside>
  );
}

function NodeButton({
  node,
  displayStatus,
  selected,
  onSelect,
}: {
  node: TapNodeView;
  displayStatus: DisplayStatus;
  selected: boolean;
  onSelect(nodeId: string): void;
}) {
  const status = statusPresentations[displayStatus];
  return (
    <button
      type="button"
      className={`tap-node-button is-${displayStatus}${selected ? " is-selected" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(node.id)}
    >
      <span className="tap-node-heading">
        <span className="tap-node-title">{node.title}</span>
        <ModuleTag module={node.module} />
      </span>
      <span className="tap-node-status">
        {status.icon}
        <span>{status.label}</span>
      </span>
    </button>
  );
}

/** 投影 status 是节点默认态；导航状态必须结合 Turn 是否终止与节点位置。 */
function deriveNodeStates(turn: TapTurnView): Map<string, DisplayStatus> {
  const nodes = turn.steps.flatMap((step) => step.nodes);
  return new Map(nodes.map((node) => [
    node.id,
    node.status === "running" ? "current" : node.status,
  ]));
}
