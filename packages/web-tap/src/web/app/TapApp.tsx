import { App as AntdApp, ConfigProvider } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { connectEventFeed } from "../api/event-feed.js";
import { AgentInsightsRail } from "../features/layout/AgentInsightsRail.js";
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

interface TapAppProps {
  store?: StoreApi<TapState>;
}

const tapTheme = {
  cssVar: { key: "tap" },
  token: {
    borderRadius: 6,
  },
} as const;

/** TAP 工作区入口；Store 可注入，事件连接仍只在顶层建立一次。 */
export function TapApp({ store = tapStore }: TapAppProps) {
  const turns = useStore(store, selectTurns);
  const nodes = useStore(store, selectNodes);
  const connectionStatus = useStore(store, (state) => state.connectionStatus);
  const selectedTurnId = useStore(store, (state) => state.selectedTurnId);
  const selectedNodeId = useStore(store, (state) => state.selectedNodeId);
  const selectTurn = useStore(store, (state) => state.selectTurn);
  const selectNode = useStore(store, (state) => state.selectNode);
  const [metricsCollapsed, setMetricsCollapsed] = useState(false);

  useEffect(() => connectEventFeed(store), [store]);

  const selectedTurnIndex = turns.findIndex((turn) => turn.id === selectedTurnId);
  const selectedTurn = selectedTurnIndex >= 0 ? turns[selectedTurnIndex] : undefined;
  const turnAnalysis = useMemo(
    () => selectedTurn === undefined ? undefined : analyzeAgentTurn(selectedTurn),
    [selectedTurn],
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);

  return (
    <ConfigProvider theme={tapTheme}>
      <AntdApp>
        <div className="tap-app-shell">
          <TapHeader connectionStatus={connectionStatus} />
          <div className="tap-app-body">
            <TurnList
              turns={turns}
              selectedTurnId={selectedTurnId}
              connectionStatus={connectionStatus}
              onSelect={selectTurn}
            />
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
                <AgentInsightsRail
                  analysis={turnAnalysis}
                  collapsed={metricsCollapsed}
                  onToggle={() => setMetricsCollapsed((value) => !value)}
                />
              </div>
            </section>
          </div>
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
