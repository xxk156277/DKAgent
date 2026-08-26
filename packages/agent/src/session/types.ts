import type { ConversationContextState } from "../context/types.js";
import type { AgentMessage } from "../query-engine/provider.js";

/** 一次可以跨进程恢复的普通对话快照。 */
export interface SessionSnapshot {
    /** Session 唯一标识。 */
    id: string;
    /** AgentLoop 保存的完整原始消息。 */
    messages: AgentMessage[];
    /** ContextManager 增量压缩所需的最新状态。 */
    contextState: ConversationContextState;
    /** Session 创建时间。 */
    createdAt: string;
    /** Session 最近一次持久化更新时间。 */
    updatedAt: string;
}

/** Session 列表展示所需的轻量元数据，不包含消息正文。 */
export interface SessionSummary {
    /** Session 唯一标识。 */
    id: string;
    /** Session 创建时间。 */
    createdAt: string;
    /** Session 最近一次持久化更新时间。 */
    updatedAt: string;
}

/** AgentLoop 与 CLI 使用的最小 Session 持久化端口。 */
export interface SessionStore {
    /** 创建并返回一个空 Session。 */
    create(): SessionSnapshot;
    /** 按最近更新时间从新到旧列出所有 Session。 */
    list(): SessionSummary[];
    /** 按唯一标识加载完整 Session；不存在时返回 null。 */
    load(sessionId: string): SessionSnapshot | null;
    /** 加载最近更新的 Session；不存在时返回 null。 */
    loadLatest(): SessionSnapshot | null;
    /** 删除 Session 及其关联消息；不存在时返回 false。 */
    delete(sessionId: string): boolean;
    /** 向指定 Session 追加一条完整消息。 */
    appendMessage(sessionId: string, message: AgentMessage): void;
    /** 覆盖保存指定 Session 的最新 Context 压缩状态。 */
    saveContextState(sessionId: string, state: ConversationContextState): void;
}
