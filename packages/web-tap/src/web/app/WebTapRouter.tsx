import { Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useParams } from "react-router-dom";
import { useStore } from "zustand";
import { connectEventFeed } from "../api/event-feed.js";
import { loadSessionBundle, type TapSessionDetail } from "../api/session-api.js";
import { SessionHistory } from "../features/sessions/SessionHistory.js";
import { SessionListPage } from "../features/sessions/SessionListPage.js";
import { createTapStore } from "../store/tap-store.js";
import { TapApp } from "./TapApp.js";

export function WebTapRouter() {
  return <BrowserRouter><WebTapRoutes /></BrowserRouter>;
}

export function WebTapRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SessionListPage />} />
      <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
    </Routes>
  );
}

function SessionDetailPage() {
  const sessionId = useParams().sessionId;
  const store = useMemo(() => createTapStore(), [sessionId]);
  const [session, setSession] = useState<TapSessionDetail>();
  const [error, setError] = useState<string>();
  const eventCount = useStore(store, (state) => state.events.length);

  useEffect(
    () => sessionId ? connectEventFeed(store, { sessionId }) : undefined,
    [sessionId, store],
  );

  useEffect(() => {
    let active = true;
    if (!sessionId) {
      setError("Session 不存在");
      return () => { active = false; };
    }
    setSession(undefined);
    setError(undefined);
    void loadSessionBundle(sessionId).then((bundle) => {
      if (!active) return;
      store.getState().replaceHistory(bundle.events);
      setSession(bundle.session);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [sessionId, store]);

  if (error) {
    return (
      <main className="tap-session-state">
        <Typography.Title level={1}>{error}</Typography.Title>
        <Link to="/">返回 Session 列表</Link>
      </main>
    );
  }
  if (!session || !sessionId) {
    return <main className="tap-session-state">正在加载 Session…</main>;
  }
  return (
    <div className="tap-session-detail-shell">
      <nav className="tap-session-backbar" aria-label="Session 导航">
        <Link to="/">← 返回 Sessions</Link>
        <Typography.Text code>{session.id}</Typography.Text>
      </nav>
      {eventCount > 0
        ? <TapApp connectLive={false} store={store} sessionId={sessionId} />
        : <SessionHistory session={session} />}
    </div>
  );
}
