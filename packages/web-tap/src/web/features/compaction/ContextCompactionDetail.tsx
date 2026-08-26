import { Card, Descriptions, Typography } from "antd";
import type { TraceEvent } from "@dkagent/trace";
import type { ContextDiff } from "../../model/types.js";
import { MessageList, isRecord } from "../node-detail/FieldDescriptions.js";

interface ContextCompactionDetailProps {
    diff: ContextDiff;
    rawEvents: TraceEvent[];
}

/** 上下文裁剪详情明确展示 Before/After 与完整移除消息组。 */
export function ContextCompactionDetail({ diff, rawEvents }: ContextCompactionDetailProps) {
    const triggerReason = readTriggerReason(rawEvents) ?? "检测到上下文消息裁剪";
    const items = [
        { key: "reason", label: "触发原因", children: triggerReason },
        { key: "before", label: "裁剪前", children: `${diff.beforeMessageCount} 条消息` },
        { key: "after", label: "裁剪后", children: `${diff.afterMessageCount} 条消息` },
        {
            key: "max",
            label: "最大上下文 Token",
            children: formatNumber(diff.beforeMaxContextTokens ?? diff.afterMaxContextTokens),
        },
        {
            key: "reserved",
            label: "预留输出 Token",
            children: formatNumber(diff.beforeReservedOutputTokens ?? diff.afterReservedOutputTokens),
        },
        {
            key: "estimated",
            label: "估算输入 Token",
            children: formatTransition(diff.beforeEstimatedInputTokens, diff.afterEstimatedInputTokens),
        },
        {
            key: "available",
            label: "可用输入 Token",
            children: formatTransition(diff.beforeAvailableInputTokens, diff.afterAvailableInputTokens),
        },
    ];

    return (
        <div className="tap-compaction-detail">
            <Descriptions bordered column={1} size="small" items={items} />
            <Typography.Title level={3}>移除的消息组</Typography.Title>
            {diff.removedGroups.length > 0 ? (
                <div className="tap-removed-groups">
                    {diff.removedGroups.map((group, index) => (
                        <Card
                            key={`${group.kind}-${index}`}
                            size="small"
                            title={`消息组 ${index + 1} · ${group.kind === "tool_exchange" ? "Tool 往返" : "单条消息"}`}
                        >
                            <MessageList
                                messages={group.messages}
                                defaultActiveKeys={group.messages.map((_, messageIndex) => String(messageIndex))}
                            />
                        </Card>
                    ))}
                </div>
            ) : (
                <Typography.Text type="secondary">没有识别到被移除的消息组</Typography.Text>
            )}
        </div>
    );
}

function readTriggerReason(events: TraceEvent[]): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event) continue;
        if (!isRecord(event.data)) continue;
        const reason = event.data.triggerReason ?? event.data.reason;
        if (typeof reason === "string") return reason;
    }
    return undefined;
}

function formatNumber(value: number | undefined): string {
    return value === undefined ? "—" : value.toLocaleString("zh-CN");
}

function formatTransition(before: number | undefined, after: number | undefined): string {
    return `${formatNumber(before)} → ${formatNumber(after)}`;
}
