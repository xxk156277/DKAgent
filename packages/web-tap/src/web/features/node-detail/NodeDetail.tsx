import { Alert, Card, Empty, Typography } from "antd";
import type { ReactNode } from "react";
import type { ContextDiff, TapNodeKind, TapNodeView } from "../../model/types.js";
import { RawJson } from "../../shared/RawJson.js";
import { ModuleTag } from "../../shared/ModuleTag.js";
import { ContextCompactionDetail } from "../compaction/ContextCompactionDetail.js";
import { FieldDescriptions, JsonCard, MessageList, isRecord } from "./FieldDescriptions.js";

interface NodeDetailProps {
    node: TapNodeView | undefined;
}

type NodeRenderer = (node: TapNodeView) => ReactNode;

const nodeRenderers: Record<TapNodeKind, NodeRenderer> = {
    turn_start: renderFields,
    context_before: renderContext,
    context_after: renderContext,
    context_trimmed: renderContextTrim,
    step_start: renderFields,
    context_tokens: renderFields,
    context_threshold: renderFields,
    context_compaction_plan: renderFields,
    context_summary_request: renderModelRequest,
    context_summary_response: renderModelResponse,
    context_compaction_completed: renderFields,
    model_request: renderModelRequest,
    model_response: renderModelResponse,
    memory_operation: renderFields,
    skill_operation: renderFields,
    artifact_operation: renderFields,
    tool_call: renderFields,
    tool_result: renderFields,
    turn_end: renderFields,
    turn_error: renderError,
    unknown: (node) => <JsonCard title="未知节点数据" value={node.detail} />,
};

/** 中栏通过稳定注册表分派节点详情；未知数据始终回退到 JSON。 */
export function NodeDetail({ node }: NodeDetailProps) {
    if (!node) {
        return (
            <section className="tap-node-detail" aria-labelledby="node-detail-heading">
                <Typography.Title id="node-detail-heading" level={2}>
                    节点详情
                </Typography.Title>
                <Empty description="尚未选择节点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </section>
        );
    }
    const title = node.kind === "context_trimmed" ? "上下文裁剪" : node.title;
    const renderNode = nodeRenderers[node.kind] ?? nodeRenderers.unknown;
    return (
        <section className="tap-node-detail" aria-labelledby="node-detail-heading">
            <header className="tap-detail-header">
                <div className="tap-detail-title">
                    <Typography.Title id="node-detail-heading" level={2}>
                        {title}
                    </Typography.Title>
                    <ModuleTag module={node.module} />
                </div>
                <Typography.Text type="secondary">{node.eventType}</Typography.Text>
            </header>
            <div className="tap-detail-body">{renderNode(node)}</div>
            <RawJson rawEvents={node.rawEvents} />
        </section>
    );
}

function renderFields(node: TapNodeView): ReactNode {
    return <FieldDescriptions data={node.detail} />;
}

function renderContext(node: TapNodeView): ReactNode {
    if (!isRecord(node.detail)) return <JsonCard title="Context" value={node.detail} />;
    const context = isRecord(node.detail.context) ? node.detail.context : node.detail;
    const messages = Array.isArray(context.messages) ? context.messages : [];
    return (
        <div className="tap-context-detail">
            <FieldDescriptions data={context} omitKeys={["messages"]} />
            <Card className="tap-data-card" size="small" title="消息">
                <MessageList messages={messages} />
            </Card>
        </div>
    );
}

function renderModelRequest(node: TapNodeView): ReactNode {
    if (!isRecord(node.detail)) return <JsonCard title="模型请求数据" value={node.detail} />;
    const messages = Array.isArray(node.detail.messages) ? node.detail.messages : [];
    return (
        <div className="tap-model-detail">
            <FieldDescriptions data={node.detail} omitKeys={["messages"]} />
            <Card className="tap-data-card" size="small" title="请求消息">
                <MessageList messages={messages} />
            </Card>
        </div>
    );
}

function renderModelResponse(node: TapNodeView): ReactNode {
    if (!isRecord(node.detail)) return <JsonCard title="模型响应数据" value={node.detail} />;
    return <FieldDescriptions data={node.detail} markdownContent />;
}

function renderContextTrim(node: TapNodeView): ReactNode {
    return isContextDiff(node.detail) ? (
        <ContextCompactionDetail diff={node.detail} rawEvents={node.rawEvents} />
    ) : (
        <JsonCard title="上下文裁剪数据" value={node.detail} />
    );
}

function renderError(node: TapNodeView): ReactNode {
    const nestedError = isRecord(node.detail) && isRecord(node.detail.error) ? node.detail.error.message : undefined;
    const message = isRecord(node.detail)
        ? String(node.detail.message ?? nestedError ?? "Agent 运行失败")
        : String(node.detail ?? "Agent 运行失败");
    return (
        <div className="tap-error-detail">
            <Alert type="error" showIcon title="运行错误" description={message} />
            <FieldDescriptions data={node.detail} />
        </div>
    );
}

function isContextDiff(value: unknown): value is ContextDiff {
    if (!isRecord(value)) return false;
    return (
        Array.isArray(value.before) &&
        Array.isArray(value.after) &&
        Array.isArray(value.removedGroups) &&
        typeof value.beforeMessageCount === "number" &&
        typeof value.afterMessageCount === "number"
    );
}
