import CheckCircleFilled from "@ant-design/icons/CheckCircleFilled";
import ClockCircleFilled from "@ant-design/icons/ClockCircleFilled";
import CloseCircleFilled from "@ant-design/icons/CloseCircleFilled";
import { Empty, Typography } from "antd";
import type { ReactNode } from "react";
import type { TapNodeView, TapTurnView } from "../../model/types.js";

interface NodeNavProps {
  turn: TapTurnView | undefined;
  turnIndex: number;
  selectedNodeId: string | null;
  onSelect(nodeId: string): void;
}

const statusPresentations: Record<TapNodeView["status"], { icon: ReactNode; label: string }> = {
  running: { icon: <ClockCircleFilled aria-hidden="true" />, label: "进行中" },
  completed: { icon: <CheckCircleFilled aria-hidden="true" />, label: "已完成" },
  error: { icon: <CloseCircleFilled aria-hidden="true" />, label: "错误" },
};

/** 右栏保持 Step 层级，并让每一个 Node 都可独立选择。 */
export function NodeNav({ turn, turnIndex, selectedNodeId, onSelect }: NodeNavProps) {
  const heading = turn ? `第 ${turnIndex} 轮节点` : "节点导航";
  return (
    <aside className="tap-region tap-node-region" aria-labelledby="node-navigation-heading">
      <header className="tap-region-header">
        <Typography.Title id="node-navigation-heading" level={2}>{heading}</Typography.Title>
      </header>
      {turn ? (
        <div className="tap-step-list">
          {turn.steps.map((step) => (
            <section className="tap-step" key={step.step} aria-labelledby={`step-${turn.id}-${step.step}`}>
              <Typography.Title id={`step-${turn.id}-${step.step}`} level={3}>Step {step.step}</Typography.Title>
              <div className="tap-node-list">
                {step.nodes.map((node) => (
                  <NodeButton
                    key={node.id}
                    node={node}
                    selected={node.id === selectedNodeId}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty description="暂无可导航节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </aside>
  );
}

function NodeButton({
  node,
  selected,
  onSelect,
}: {
  node: TapNodeView;
  selected: boolean;
  onSelect(nodeId: string): void;
}) {
  const status = statusPresentations[node.status];
  const toolCallId = readToolCallId(node);
  return (
    <button
      type="button"
      className={`tap-node-button is-${node.status}${selected ? " is-selected" : ""}${toolCallId ? " is-tool-node" : ""}`}
      aria-current={selected ? "true" : undefined}
      data-tool-call-id={toolCallId}
      onClick={() => onSelect(node.id)}
    >
      <span className="tap-node-title">{node.title}</span>
      {toolCallId ? <span className="tap-tool-call-id">调用 {toolCallId}</span> : null}
      <span className="tap-node-status">
        {status.icon}
        <span>{status.label}</span>
      </span>
    </button>
  );
}

function readToolCallId(node: TapNodeView): string | undefined {
  if (node.kind !== "tool_call" && node.kind !== "tool_result") return undefined;
  if (typeof node.detail !== "object" || node.detail === null) return undefined;
  const detail = node.detail as Record<string, unknown>;
  const value = node.kind === "tool_call" ? detail.id : detail.toolCallId;
  return typeof value === "string" ? value : undefined;
}
