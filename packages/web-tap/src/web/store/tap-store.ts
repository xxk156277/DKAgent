import { useStore } from "zustand";
import type { RuntimeEvent } from "@dkagent/agent/runtime-events";
import { createStore } from "zustand/vanilla";
import { mergeViewerEvents } from "../../tap/viewer-state.js";
import { projectEvents } from "../model/project-events.js";

export interface TapState {
  events: RuntimeEvent[];
  connectionStatus: "connecting" | "live" | "reconnecting" | "error";
  selectedSessionId: string | null;
  selectedTurnId: string | null;
  selectedNodeId: string | null;
  followLive: boolean;
  replaceHistory(events: RuntimeEvent[]): void;
  appendEvent(event: RuntimeEvent): void;
  selectTurn(turnId: string): void;
  selectNode(nodeId: string): void;
  setConnectionStatus(status: TapState["connectionStatus"]): void;
}

/** 创建独立 Store，供页面与测试各自持有事件状态。 */
export function createTapStore() {
  return createStore<TapState>()((set, get) => ({
    events: [],
    connectionStatus: "connecting",
    selectedSessionId: null,
    selectedTurnId: null,
    selectedNodeId: null,
    followLive: true,
    replaceHistory(events) {
      updateEvents(set, get, mergeViewerEvents(get().events, events));
    },
    appendEvent(event) {
      updateEvents(set, get, mergeViewerEvents(get().events, [event]));
    },
    selectTurn(turnId) {
      const selection = findTurnSelection(get().events, turnId);
      if (selection) set({ ...selection, followLive: false });
    },
    selectNode(nodeId) {
      const selection = findNodeSelection(get().events, nodeId);
      if (selection) set({ ...selection, followLive: false });
    },
    setConnectionStatus(connectionStatus) {
      set({ connectionStatus });
    },
  }));
}

/** 页面共享的默认 Store；测试可通过 createTapStore 隔离实例。 */
export const tapStore = createTapStore();

/** React 组件只订阅传入 selector 所需的最小状态切片。 */
export function useTapStore<T>(selector: (state: TapState) => T): T {
  return useStore(tapStore, selector);
}

/** 从原始事件即时投影 Session，避免在 Store 中维护镜像数据。 */
export function selectSessions(state: TapState) {
  return projectEvents(state.events);
}

/** 仅返回当前 Session 的 Turn 列表。 */
export function selectTurns(state: TapState) {
  return selectSessions(state).find((session) => session.id === state.selectedSessionId)?.turns ?? [];
}

/** 仅返回当前 Turn 的扁平 Node 列表。 */
export function selectNodes(state: TapState) {
  return selectTurns(state)
    .find((turn) => turn.id === state.selectedTurnId)?.steps
    .flatMap((step) => step.nodes) ?? [];
}

function updateEvents(
  set: (partial: Partial<TapState>) => void,
  get: () => TapState,
  events: RuntimeEvent[],
): void {
  const state = get();
  const shouldFollow = state.followLive || state.selectedTurnId === null;
  set({ events, ...(shouldFollow ? findLatestSelection(events) ?? {} : {}) });
}

function findLatestSelection(events: RuntimeEvent[]): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
  const sessions = projectEvents(events);
  const session = sessions.at(-1);
  const turn = session?.turns.at(-1);
  const step = turn?.steps.at(-1);
  const node = step?.nodes.at(-1);
  if (!session || !turn || !node) return undefined;
  return {
    selectedSessionId: session.id,
    selectedTurnId: turn.id,
    selectedNodeId: node.id,
  };
}

function findTurnSelection(events: RuntimeEvent[], turnId: string): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
  for (const session of projectEvents(events)) {
    const turn = session.turns.find((item) => item.id === turnId);
    const node = turn?.steps.at(-1)?.nodes.at(-1);
    if (turn && node) {
      return { selectedSessionId: session.id, selectedTurnId: turn.id, selectedNodeId: node.id };
    }
  }
  return undefined;
}

function findNodeSelection(events: RuntimeEvent[], nodeId: string): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
  for (const session of projectEvents(events)) {
    for (const turn of session.turns) {
      if (turn.steps.some((step) => step.nodes.some((node) => node.id === nodeId))) {
        return { selectedSessionId: session.id, selectedTurnId: turn.id, selectedNodeId: nodeId };
      }
    }
  }
  return undefined;
}
