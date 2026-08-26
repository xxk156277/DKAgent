import { Empty, Tag, Typography } from "antd";
import { summarizeTurn } from "../../model/turn-summary.js";
import type { TapTurnView } from "../../model/types.js";

export function TurnHeader({ turn, turnIndex }: { turn: TapTurnView | undefined; turnIndex: number }) {
    if (!turn) return <Empty description="暂无当前 Turn" image={Empty.PRESENTED_IMAGE_SIMPLE} />;

    const summary = summarizeTurn(turn);
    const tagColor = summary.status === "error" ? "error" : summary.status === "completed" ? "success" : "processing";

    return (
        <header className="tap-turn-header">
            <div>
                <Typography.Title level={1}>第 {turnIndex} 轮</Typography.Title>
                <Typography.Text ellipsis={{ tooltip: summary.input }}>{summary.input}</Typography.Text>
            </div>
            <Tag color={tagColor}>{summary.statusLabel}</Tag>
        </header>
    );
}
