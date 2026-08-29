import { Alert, Card, Descriptions, Empty, Typography } from "antd";
import type { TapNodeView } from "../../model/types.js";
import { ModuleTag } from "../../shared/ModuleTag.js";
import { RawJson } from "../../shared/RawJson.js";
import { FieldDescriptions, JsonCard, MessageList, isRecord } from "./FieldDescriptions.js";

export function NodeDetail({ node }: { node: TapNodeView | undefined }) {
  if (!node) {
    return (
      <section className="tap-node-detail" aria-labelledby="node-detail-heading">
        <Typography.Title id="node-detail-heading" level={2}>节点详情</Typography.Title>
        <Empty description="尚未选择节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </section>
    );
  }
  const detail = isRecord(node.detail) ? node.detail : {};
  return (
    <section className="tap-node-detail" aria-labelledby="node-detail-heading">
      <header className="tap-detail-header">
        <div className="tap-detail-title">
          <Typography.Title id="node-detail-heading" level={2}>{node.title}</Typography.Title>
          <ModuleTag module={node.module} />
        </div>
        <Typography.Text type="secondary">{node.eventType}</Typography.Text>
      </header>
      <div className="tap-detail-body">
        {node.integrityWarnings.length > 0 ? (
          <Alert type="warning" showIcon title="Trace 完整性告警" description={node.integrityWarnings.join("、")} />
        ) : null}
        {node.status === "error" ? (
          <Alert type="error" showIcon title="运行错误" description={formatError(detail.error)} />
        ) : null}
        <Descriptions bordered column={1} size="small" items={[
          { key: "status", label: "状态", children: node.status },
          { key: "revision", label: "Revision", children: node.revision },
          { key: "sequence", label: "Sequence", children: node.sequence },
          { key: "parent", label: "父 Span", children: node.parentSpanId ?? "根节点" },
          { key: "direct-token", label: "直接 Token", children: formatUsage(node.directTokenUsage) },
          { key: "subtree-token", label: "子树 Token", children: formatUsage(node.subtreeTokenUsage) },
          { key: "duration", label: "总耗时", children: formatDuration(node.durationMs, node.status) },
          { key: "self-duration", label: "自身耗时", children: formatDuration(node.selfDurationMs, node.status) },
        ]} />
        <JsonCard title="输入" value={detail.input} />
        <JsonCard title="输出" value={detail.output} />
        {node.kind === "model.generate" && isRecord(detail.input) && Array.isArray(detail.input.messages) ? (
          <Card className="tap-data-card" size="small" title="最终请求消息">
            <MessageList messages={detail.input.messages} />
          </Card>
        ) : null}
        <Card className="tap-data-card" size="small" title="Span Event">
          <FieldDescriptions data={detail.events} />
        </Card>
      </div>
      <RawJson values={node.rawSpans} />
    </section>
  );
}

function formatUsage(value: TapNodeView["directTokenUsage"]): string {
  return value ? `${value.inputTokens} / ${value.outputTokens}` : "未记录";
}

function formatDuration(value: number | undefined, status: TapNodeView["status"]): string {
  if (status === "running") return "未完成";
  return value === undefined ? "无法计算" : `${value} 毫秒`;
}

function formatError(value: unknown): string {
  return isRecord(value) && typeof value.message === "string" ? value.message : "Agent 运行失败";
}
