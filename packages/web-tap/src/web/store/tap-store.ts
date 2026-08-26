import { useStore } from "zustand";
import type { TraceEvent } from "@dkagent/trace";
import { createStore } from "zustand/vanilla";
import { mergeViewerEvents } from "../../tap/viewer-state.js";
import { projectEvents } from "../model/project-events.js";
import type { TapNodeView, TapSessionView, TapTurnView } from "../model/types.js";

const sessionProjectionCache = new WeakMap<TraceEvent[], TapSessionView[]>();
const nodeProjectionCache = new WeakMap<TapTurnView, TapNodeView[]>();
const emptyTurns: TapTurnView[] = [];
const emptyNodes: TapNodeView[] = [];

export interface TapState {
    events: TraceEvent[];
    connectionStatus: "connecting" | "live" | "reconnecting" | "error";
    selectedSessionId: string | null;
    selectedTurnId: string | null;
    selectedNodeId: string | null;
    followLive: boolean;
    replaceHistory(events: TraceEvent[]): void;
    appendEvent(event: TraceEvent): void;
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
            if (selection) {
                const latest = findLatestSelection(get().events);
                set({
                    ...selection,
                    // 重新选择最新 Turn 时恢复自动跟随；历史 Turn 则保持用户视角。
                    followLive: latest?.selectedTurnId === selection.selectedTurnId,
                });
            }
        },
        selectNode(nodeId) {
            const selection = findNodeSelection(get().events, nodeId);
            if (selection) {
                const latest = findLatestSelection(get().events);
                set({
                    ...selection,
                    followLive: latest?.selectedNodeId === selection.selectedNodeId,
                });
            }
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
    const cached = sessionProjectionCache.get(state.events);
    if (cached) return cached;
    const sessions = projectEvents(state.events);
    sessionProjectionCache.set(state.events, sessions);
    return sessions;
}

/** 仅返回当前 Session 的 Turn 列表。 */
export function selectTurns(state: TapState) {
    return selectSessions(state).find((session) => session.id === state.selectedSessionId)?.turns ?? emptyTurns;
}

/** 仅返回当前 Turn 的扁平 Node 列表。 */
export function selectNodes(state: TapState) {
    const turn = selectTurns(state).find((item) => item.id === state.selectedTurnId);
    if (!turn) return emptyNodes;
    const cached = nodeProjectionCache.get(turn);
    if (cached) return cached;
    const nodes = turn.steps.flatMap((step) => step.nodes);
    nodeProjectionCache.set(turn, nodes);
    return nodes;
}

function updateEvents(set: (partial: Partial<TapState>) => void, get: () => TapState, events: TraceEvent[]): void {
    const state = get();
    const shouldFollow = state.followLive || state.selectedTurnId === null;
    set({ events, ...(shouldFollow ? (findLatestSelection(events) ?? {}) : {}) });
}

function findLatestSelection(
    events: TraceEvent[],
): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
    const latestEvent = findLatestTraceEvent(events);
    if (!latestEvent) return undefined;
    const sessions = projectEvents(events);
    const session = sessions[0];
    const turn = session?.turns.find((item) => item.id === latestEvent.traceId);
    const node =
        turn?.steps
            .flatMap((step) => step.nodes)
            .filter((item) => item.eventIds.includes(latestEvent.id))
            .at(-1) ?? turn?.steps.at(-1)?.nodes.at(-1);
    if (!session || !turn || !node) return undefined;
    return {
        selectedSessionId: session.id,
        selectedTurnId: turn.id,
        selectedNodeId: node.id,
    };
}

/** 按全局时间、sequence 与原始输入顺序确定最后活动的 Runtime Event。 */
function findLatestTraceEvent(events: TraceEvent[]): TraceEvent | undefined {
    return events.reduce<TraceEvent | undefined>((latest, event) => {
        if (!latest) return event;
        const timestampDifference = parseEventTimestamp(event.timestamp) - parseEventTimestamp(latest.timestamp);
        if (timestampDifference !== 0) return timestampDifference > 0 ? event : latest;
        if (event.sequence !== latest.sequence) return event.sequence > latest.sequence ? event : latest;
        // 相同排序键时，reduce 中靠后的事件是稳定的最终 tie-breaker。
        return event;
    }, undefined);
}

function parseEventTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function findTurnSelection(
    events: TraceEvent[],
    turnId: string,
): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
    for (const session of projectEvents(events)) {
        const turn = session.turns.find((item) => item.id === turnId);
        const node = turn?.steps.at(-1)?.nodes.at(-1);
        if (turn && node) {
            return { selectedSessionId: session.id, selectedTurnId: turn.id, selectedNodeId: node.id };
        }
    }
    return undefined;
}

function findNodeSelection(
    events: TraceEvent[],
    nodeId: string,
): Pick<TapState, "selectedSessionId" | "selectedTurnId" | "selectedNodeId"> | undefined {
    for (const session of projectEvents(events)) {
        for (const turn of session.turns) {
            if (turn.steps.some((step) => step.nodes.some((node) => node.id === nodeId))) {
                return { selectedSessionId: session.id, selectedTurnId: turn.id, selectedNodeId: nodeId };
            }
        }
    }
    return undefined;
}
