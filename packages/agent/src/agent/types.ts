import type { QueryEngine } from "../query-engine/query-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ContextBuilder } from "../context/types.js";
import type { RuntimeEventSink } from "../runtime/events.js";


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
    /** Agent 的固定系统提示词。 */
    systemPrompt?: string;
    /** 一次 Agent Run 最多执行多少轮模型或 Tool。 */
    maxSteps?: number;
    /** 用于中止当前 Agent。 */
    abortSignal?: AbortSignal;
    /** 模型流式文本回调。 */
    onTextDelta?: (text: string) => void;
    /** 可选运行事件出口；未提供时不产生观测副作用。 */
    runtimeEventSink?: RuntimeEventSink;
}
