import type { QueryEngine } from "../query-engine/query-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ContextBuilder, ContextCompactionOptions } from "../context/types.js";
import type { Tracer } from "@dkagent/trace";
import type { SessionSnapshot, SessionStore } from "../session/types.js";
import type { MemoryReader, MemoryWriter } from "../memory/types.js";
import type { ArtifactStore } from "../artifact/types.js";

/** AgentLoop 当前绑定的 Session。 */
export interface AgentLoopSessionOptions {
    /** 构造 AgentLoop 时用于恢复历史的 Session 快照。 */
    snapshot: SessionSnapshot;
    /** 保存当前 Session 增量变化的持久化端口。 */
    store: SessionStore;
}

export interface AgentLoopOptions {
    /** 模型请求中心。 */
    queryEngine: QueryEngine;
    /** 当前 Agent 可以使用的工具注册表。 */
    toolRegistry: ToolRegistry;
    /** 为每次模型请求构建上下文快照。 */
    contextManager: ContextBuilder;
    /** 当前使用的模型 ID。 */
    model: string;
    /** 模型支持的最大上下文 Token 数。 */
    maxContextTokens: number;
    /** 模型本轮最多可以输出的 Token 数。 */
    maxOutputTokens: number;
    /** 可选的历史压缩策略；未提供时继续使用 Context V1 裁剪。 */
    contextCompaction?: ContextCompactionOptions;
    /** 摘要任务使用的模型 ID；未提供时复用主模型。 */
    summaryModel?: string;
    /** Agent 的固定系统提示词。 */
    systemPrompt?: string;
    /** 一次 Agent Run 最多执行多少轮模型或 Tool。 */
    maxSteps?: number;
    /** 用于中止当前 Agent。 */
    abortSignal?: AbortSignal;
    /** 模型流式文本回调。 */
    onTextDelta?: (text: string) => void;
    /** 可选被动追踪器；未提供时使用无副作用空追踪器。 */
    tracer?: Tracer;
    /** 可选 Session；未提供时保持原有纯内存行为。 */
    session?: AgentLoopSessionOptions;
    /** 每个 Turn 开始时召回跨 Session 记忆。 */
    memoryReader?: MemoryReader;
    /** 成功文本回答后提取并保存稳定记忆。 */
    memoryWriter?: MemoryWriter;
    /** 当前 AgentLoop 使用的 ArtifactStore；未提供时创建内存 Store。 */
    artifactStore?: ArtifactStore;
}
