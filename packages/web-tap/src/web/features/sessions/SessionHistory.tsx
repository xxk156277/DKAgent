import { Alert, Card, Empty, Typography } from "antd";
import type { TapSessionDetail } from "../../api/session-api.js";

const roleLabels: Record<string, string> = {
    system: "系统",
    user: "用户",
    assistant: "Agent",
    tool: "工具",
};

export function SessionHistory({ session }: { session: TapSessionDetail }) {
    return (
        <main className="tap-session-history">
            <Alert
                showIcon
                type="info"
                title="暂无运行轨迹"
                description="该 Session 保存了真实消息，但当前 Trace Store 中没有对应运行记录。"
            />
            <section aria-labelledby="session-history-heading">
                <Typography.Title id="session-history-heading" level={2}>
                    对话消息
                </Typography.Title>
                {session.messages.length === 0 ? (
                    <Empty description="暂无消息" />
                ) : (
                    session.messages.map((message, index) => (
                        <Card
                            className="tap-session-message"
                            key={index}
                            size="small"
                            title={`${roleLabel(message)} · 第 ${index + 1} 条`}
                        >
                            <Typography.Paragraph>{messageContent(message)}</Typography.Paragraph>
                        </Card>
                    ))
                )}
            </section>
        </main>
    );
}

function roleLabel(message: unknown): string {
    const role = isRecord(message) && typeof message.role === "string" ? message.role : "unknown";
    return roleLabels[role] ?? "未知角色";
}

function messageContent(message: unknown): string {
    if (!isRecord(message)) return String(message);
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? message, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
