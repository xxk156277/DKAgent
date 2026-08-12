import { App as AntdApp, ConfigProvider } from "antd";
import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { connectEventFeed } from "../api/event-feed.js";
import { NodeDetail } from "../features/node-detail/NodeDetail.js";
import { NodeDetailBoundary } from "../features/node-detail/NodeDetailBoundary.js";
import { NodeNav } from "../features/timeline/NodeNav.js";
import { TurnList } from "../features/turns/TurnList.js";
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

/** TAP 三栏入口；Store 可注入，事件连接仍只在顶层建立一次。 */
export function TapApp({ store = tapStore }: TapAppProps) {
  const turns = useStore(store, selectTurns);
  const nodes = useStore(store, selectNodes);
  const connectionStatus = useStore(store, (state) => state.connectionStatus);
  const selectedTurnId = useStore(store, (state) => state.selectedTurnId);
  const selectedNodeId = useStore(store, (state) => state.selectedNodeId);
  const selectTurn = useStore(store, (state) => state.selectTurn);
  const selectNode = useStore(store, (state) => state.selectNode);

  useEffect(() => connectEventFeed(store), [store]);

  const selectedTurnIndex = turns.findIndex((turn) => turn.id === selectedTurnId);
  const selectedTurn = selectedTurnIndex >= 0 ? turns[selectedTurnIndex] : undefined;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);

  return (
    <ConfigProvider theme={tapTheme}>
      <AntdApp>
        <div className="tap-app-shell">
          <TurnList
            turns={turns}
            selectedTurnId={selectedTurnId}
            connectionStatus={connectionStatus}
            onSelect={selectTurn}
          />
          <main className="tap-region tap-detail-region">
            <NodeDetailBoundary key={selectedNodeId ?? "empty"} node={selectedNode}>
              <NodeDetail node={selectedNode} />
            </NodeDetailBoundary>
          </main>
          <NodeNav
            turn={selectedTurn}
            turnIndex={selectedTurnIndex + 1}
            selectedNodeId={selectedNodeId}
            onSelect={selectNode}
          />
        </div>
      </AntdApp>
    </ConfigProvider>
  );
}
