import { App as AntdApp, Button, ConfigProvider, Drawer } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { connectEventFeed } from "../api/event-feed.js";
import { AgentInsightsContent, AgentInsightsRail } from "../features/layout/AgentInsightsRail.js";
import { TapHeader } from "../features/layout/TapHeader.js";
import { TurnHeader } from "../features/layout/TurnHeader.js";
import { NodeDetail } from "../features/node-detail/NodeDetail.js";
import { NodeDetailBoundary } from "../features/node-detail/NodeDetailBoundary.js";
import { NodeNav } from "../features/timeline/NodeNav.js";
import { TurnList } from "../features/turns/TurnList.js";
import { analyzeAgentTurn } from "../model/agent-turn-analysis.js";
import {
  selectNodes,
  selectTurns,
  tapStore,
  type TapState,
} from "../store/tap-store.js";
import { useTapViewport } from "../shared/useTapViewport.js";

interface TapAppProps {
  store?: StoreApi<TapState>;
  sessionId?: string;
  connectLive?: boolean;
}

const tapTheme = {
  cssVar: { key: "tap" },
  token: {
    borderRadius: 6,
  },
} as const;

/** TAP 工作区入口；Store 可注入，事件连接仍只在顶层建立一次。 */
export function TapApp({ store = tapStore, sessionId, connectLive = true }: TapAppProps) {
  const turns = useStore(store, selectTurns);
  const nodes = useStore(store, selectNodes);
  const connectionStatus = useStore(store, (state) => state.connectionStatus);
  const selectedTurnId = useStore(store, (state) => state.selectedTurnId);
  const selectedNodeId = useStore(store, (state) => state.selectedNodeId);
  const selectTurn = useStore(store, (state) => state.selectTurn);
  const selectNode = useStore(store, (state) => state.selectNode);
  const viewport = useTapViewport();
  const mobile = viewport === "mobile";
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [metricsCollapsed, setMetricsCollapsed] = useState(viewport !== "wide");

  useEffect(
    () => connectLive
      ? connectEventFeed(store, sessionId ? { sessionId } : {})
      : undefined,
    [connectLive, sessionId, store],
  );

  useEffect(() => {
    setMetricsCollapsed(viewport !== "wide");
    if (!mobile) {
      setTurnsOpen(false);
      setInsightsOpen(false);
    }
  }, [mobile, viewport]);

  const selectedTurnIndex = turns.findIndex((turn) => turn.id === selectedTurnId);
  const selectedTurn = selectedTurnIndex >= 0 ? turns[selectedTurnIndex] : undefined;
  const turnAnalysis = useMemo(
    () => selectedTurn === undefined ? undefined : analyzeAgentTurn(selectedTurn),
    [selectedTurn],
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const attentionCount = turnAnalysis?.evaluations.filter(
    (item) => item.status === "warning" || item.status === "failed",
  ).length ?? 0;

  return (
    <ConfigProvider theme={tapTheme}>
      <AntdApp>
        <div className="tap-app-shell">
          <TapHeader
            connectionStatus={connectionStatus}
            mobile={mobile}
            attentionCount={attentionCount}
            onOpenTurns={() => setTurnsOpen(true)}
            onOpenInsights={() => setInsightsOpen(true)}
          />
          <div className="tap-app-body">
            {mobile ? null : (
              <TurnList
                turns={turns}
                selectedTurnId={selectedTurnId}
                connectionStatus={connectionStatus}
                onSelect={selectTurn}
              />
            )}
            <section
              className="tap-workspace"
              aria-label={selectedTurn ? `第 ${selectedTurnIndex + 1} 轮工作区` : "当前 Turn 工作区"}
            >
              <TurnHeader turn={selectedTurn} turnIndex={selectedTurnIndex + 1} />
              <div className="tap-workspace-content">
                <section className="tap-execution-workspace" aria-label="执行过程">
                  <NodeNav
                    turn={selectedTurn}
                    turnIndex={selectedTurnIndex + 1}
                    selectedNodeId={selectedNodeId}
                    onSelect={selectNode}
                  />
                  <main className="tap-region tap-detail-region">
                    <NodeDetailBoundary key={selectedNodeId ?? "empty"} node={selectedNode}>
                      <NodeDetail node={selectedNode} />
                    </NodeDetailBoundary>
                  </main>
                </section>
                {mobile ? null : (
                  <AgentInsightsRail
                    analysis={turnAnalysis}
                    collapsed={metricsCollapsed}
                    onToggle={() => setMetricsCollapsed((value) => !value)}
                  />
                )}
              </div>
            </section>
          </div>
          <Drawer
            title="对话轮次"
            aria-label="对话轮次"
            placement="left"
            size="min(88vw, 360px)"
            open={mobile && turnsOpen}
            closeIcon={null}
            destroyOnHidden
            extra={<Button type="text" aria-label="关闭对话轮次" onClick={() => setTurnsOpen(false)}>关闭</Button>}
            onClose={() => setTurnsOpen(false)}
          >
            <TurnList
              turns={turns}
              selectedTurnId={selectedTurnId}
              connectionStatus={connectionStatus}
              onSelect={(turnId) => {
                selectTurn(turnId);
                setTurnsOpen(false);
              }}
            />
          </Drawer>
          <Drawer
            title="Agent 指标"
            aria-label="Agent 指标"
            placement="right"
            size="min(92vw, 420px)"
            open={mobile && insightsOpen}
            destroyOnHidden
            onClose={() => setInsightsOpen(false)}
          >
            <AgentInsightsContent analysis={turnAnalysis} />
          </Drawer>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
