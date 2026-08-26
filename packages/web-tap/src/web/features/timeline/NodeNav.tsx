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
type ToolPairPosition = "start" | "end";

const statusPresentations: Record<DisplayStatus, { icon: ReactNode; label: string }> = {
    current: { icon: <ClockCircleFilled aria-hidden="true" />, label: "当前" },
    completed: { icon: <CheckCircleFilled aria-hidden="true" />, label: "已完成" },
    error: { icon: <CloseCircleFilled aria-hidden="true" />, label: "错误" },
};

/** 右栏保持 Step 层级，并让每一个 Node 都可独立选择。 */
export function NodeNav({ turn, turnIndex, selectedNodeId, onSelect }: NodeNavProps) {
    const heading = turn ? `第 ${turnIndex} 轮节点` : "节点导航";
    const nodeStates = turn ? deriveNodeStates(turn) : new Map<string, DisplayStatus>();
    const toolPairs = turn ? deriveToolPairs(turn) : new Map<string, ToolPairPosition>();
    return (
        <aside className="tap-region tap-node-region" aria-labelledby="node-navigation-heading">
            <header className="tap-region-header">
                <Typography.Title id="node-navigation-heading" level={2}>
                    {heading}
                </Typography.Title>
            </header>
            {turn ? (
                <Collapse
                    key={turn.id}
                    className="tap-step-collapse"
                    defaultActiveKey={turn.steps.map((step) => String(step.step))}
                    items={turn.steps.map((step) => ({
                        key: String(step.step),
                        label: `Step ${step.step}`,
                        children: (
                            <div className="tap-node-list">
                                {step.nodes.map((node) => (
                                    <NodeButton
                                        key={node.id}
                                        node={node}
                                        displayStatus={nodeStates.get(node.id) ?? "completed"}
                                        toolPair={toolPairs.get(node.id)}
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
    toolPair,
    selected,
    onSelect,
}: {
    node: TapNodeView;
    displayStatus: DisplayStatus;
    toolPair: ToolPairPosition | undefined;
    selected: boolean;
    onSelect(nodeId: string): void;
}) {
    const status = statusPresentations[displayStatus];
    const toolCallId = readToolCallId(node);
    return (
        <button
            type="button"
            className={`tap-node-button is-${displayStatus}${selected ? " is-selected" : ""}${toolCallId ? " is-tool-node" : ""}`}
            aria-current={selected ? "true" : undefined}
            data-tool-call-id={toolCallId}
            data-tool-pair={toolPair}
            onClick={() => onSelect(node.id)}
        >
            <span className="tap-node-heading">
                <span className="tap-node-title">{node.title}</span>
                <ModuleTag module={node.module} />
            </span>
            {toolCallId ? <span className="tap-tool-call-id">调用 {toolCallId}</span> : null}
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
    const turnEnded = nodes.some((node) => node.kind === "turn_end" || node.kind === "turn_error");
    const latestNode = nodes.at(-1);
    return new Map(
        nodes.map((node) => [
            node.id,
            node.status === "error" || node.kind === "turn_error"
                ? "error"
                : turnEnded || node.id !== latestNode?.id
                  ? "completed"
                  : "current",
        ]),
    );
}

/** 相邻且 toolCallId 相同的 Call/Result 形成一个明确的视觉配对。 */
function deriveToolPairs(turn: TapTurnView): Map<string, ToolPairPosition> {
    const pairs = new Map<string, ToolPairPosition>();
    for (const step of turn.steps) {
        for (let index = 0; index < step.nodes.length - 1; index += 1) {
            const call = step.nodes[index];
            const result = step.nodes[index + 1];
            if (!call || !result || call.kind !== "tool_call" || result.kind !== "tool_result") continue;
            const callId = readToolCallId(call);
            if (callId && callId === readToolCallId(result)) {
                pairs.set(call.id, "start");
                pairs.set(result.id, "end");
            }
        }
    }
    return pairs;
}

function readToolCallId(node: TapNodeView): string | undefined {
    if (node.kind !== "tool_call" && node.kind !== "tool_result") return undefined;
    if (typeof node.detail !== "object" || node.detail === null) return undefined;
    const detail = node.detail as Record<string, unknown>;
    const value = node.kind === "tool_call" ? detail.id : detail.toolCallId;
    return typeof value === "string" ? value : undefined;
}
