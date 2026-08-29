import { Empty, Input, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { loadSessions, type TapSessionSummary } from "../../api/session-api.js";

export function SessionListPage() {
  const [sessions, setSessions] = useState<TapSessionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    void loadSessions().then((items) => {
      if (active) setSessions(items);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [reloadKey]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(() => normalizedQuery.length === 0
    ? sessions
    : sessions.filter((session) => (
      session.id.toLocaleLowerCase().includes(normalizedQuery)
      || session.preview.toLocaleLowerCase().includes(normalizedQuery)
    )), [normalizedQuery, sessions]);

  return (
    <div className="tap-session-page">
      <header className="tap-session-product-header">
        <div className="tap-brand">
          <span className="tap-brand-mark" aria-hidden="true">DK</span>
          <Typography.Text strong>DKAgent Tap</Typography.Text>
        </div>
        <span className="tap-readonly-status">● 只读观测</span>
      </header>
      <main className="tap-session-list-main">
        <div className="tap-session-list-heading">
          <div>
            <Typography.Title level={1}>Sessions</Typography.Title>
            <Typography.Text type="secondary">选择一次对话，查看 AgentLoop 的真实运行轨迹</Typography.Text>
          </div>
          <Typography.Text type="secondary">{sessions.length} 个 Session</Typography.Text>
        </div>
        <Input
          allowClear
          aria-label="搜索 Session"
          placeholder="搜索 Session ID 或用户输入"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {error ? (
          <div className="tap-session-error" role="alert">
            <Typography.Text>{error}</Typography.Text>
            <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重试</button>
          </div>
        ) : (
          loading ? <div className="tap-session-loading">正在读取 Sessions…</div> : visibleSessions.length === 0
            ? <Empty description="暂无 Session，请先运行 DKAgent" />
            : <div className="tap-session-list" role="list">
              {visibleSessions.map((session) => (
              <div className="tap-session-list-item" key={session.id} role="listitem">
                <Link className="tap-session-link" to={`/sessions/${encodeURIComponent(session.id)}`}>
                  <div className="tap-session-link-copy">
                    <Typography.Text strong>{session.preview}</Typography.Text>
                    <Typography.Text type="secondary" className="tap-session-id">{session.id}</Typography.Text>
                  </div>
                  <div className="tap-session-meta">
                    <span>{session.turnCount} 轮 · {session.messageCount} 条消息</span>
                    <span>{formatTime(session.updatedAt)}</span>
                    <Tag color={session.hasTrace ? "processing" : "default"}>
                      {session.hasTrace ? "有运行轨迹" : "暂无运行轨迹"}
                    </Tag>
                  </div>
                </Link>
              </div>
              ))}
            </div>
        )}
      </main>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
