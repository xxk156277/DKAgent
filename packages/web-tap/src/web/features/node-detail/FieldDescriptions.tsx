import { Card, Collapse, Descriptions, Empty } from "antd";
import type { ReactNode } from "react";
import { MarkdownContent } from "../../shared/MarkdownContent.js";

interface FieldDescriptionsProps {
  data: unknown;
  omitKeys?: readonly string[];
  markdownContent?: boolean;
}

const emptyKeys: readonly string[] = [];
const fieldLabels: Record<string, string> = {
  input: "输入",
  answer: "回答",
  systemPrompt: "系统提示词",
  maxTokens: "最大输出 Token",
  temperature: "温度",
  model: "模型",
  tools: "工具",
  type: "类型",
  content: "内容",
  stopReason: "停止原因",
  usage: "用量",
  id: "调用 ID",
  toolCallId: "调用 ID",
  name: "工具名称",
  result: "工具结果",
  maxContextTokens: "最大上下文 Token",
  reservedOutputTokens: "预留输出 Token",
  estimatedInputTokens: "估算输入 Token",
  availableInputTokens: "可用输入 Token",
  droppedMessageCount: "已裁剪消息数",
  triggerReason: "触发原因",
  reason: "原因",
  stage: "计算阶段",
  tokens: "Token 数",
  triggerTokens: "触发阈值 Token",
  targetTokens: "压缩目标 Token",
  exceeded: "是否超过阈值",
  strategy: "处理策略",
  tokensBefore: "压缩前 Token",
  tokensAfter: "压缩后 Token",
  tokensSaved: "节省 Token",
  savedRatio: "节省比例",
  summarizedMessageCount: "摘要消息数",
  retainedMessageCount: "保留消息数",
  fallbackUsed: "是否使用兜底",
  durationMs: "耗时（毫秒）",
};

const roleLabels: Record<string, string> = {
  system: "System 消息",
  user: "User 消息",
  assistant: "Assistant 消息",
  tool: "Tool 消息",
};

/** 使用 Descriptions 展示标量，复杂值保留为格式化 JSON。 */
export function FieldDescriptions({
  data,
  omitKeys = emptyKeys,
  markdownContent = false,
}: FieldDescriptionsProps) {
  if (!isRecord(data)) return <JsonBlock value={data} />;
  const omitted = new Set(omitKeys);
  const items = Object.entries(data)
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => ({
      key,
      label: fieldLabels[key] ?? key,
      children: renderValue(key, value, markdownContent),
    }));
  return items.length > 0
    ? <Descriptions bordered column={1} size="small" items={items} />
    : <Empty description="暂无字段" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
}

/** Context 消息按角色分组为可折叠卡片，避免长上下文挤占详情。 */
export function MessageList({
  messages,
  defaultActiveKeys = emptyKeys,
}: {
  messages: unknown[];
  defaultActiveKeys?: readonly string[];
}) {
  if (messages.length === 0) {
    return <Empty description="暂无消息" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <Collapse
      className="tap-message-list"
      defaultActiveKey={[...defaultActiveKeys]}
      items={messages.map((message, index) => {
        const role = isRecord(message) && typeof message.role === "string" ? message.role : "unknown";
        return {
          key: String(index),
          label: `第 ${index + 1} 条 · ${roleLabels[role] ?? "未知角色消息"}`,
          children: (
            <Card size="small" variant="borderless">
              {isMarkdownMessage(message)
                ? <FieldDescriptions data={message} markdownContent />
                : <JsonBlock value={message} />}
            </Card>
          ),
        };
      })}
    />
  );
}

export function JsonCard({ title, value }: { title: ReactNode; value: unknown }) {
  return (
    <Card className="tap-data-card" size="small" title={title}>
      <JsonBlock value={value} />
    </Card>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="tap-json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function renderValue(key: string, value: unknown, markdownContent: boolean): ReactNode {
  if (value === null || value === undefined) return "—";
  if (markdownContent && key === "content" && typeof value === "string") {
    return <MarkdownContent content={value} />;
  }
  if (key === "savedRatio" && typeof value === "number") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return <JsonBlock value={value} />;
}

function isMarkdownMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.content !== "string") return false;
  return value.role === "system" || value.role === "user" || value.role === "assistant";
}
