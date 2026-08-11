import type {
    AgentMessage,
    ToolSchema,
} from "../query-engine/provider.js";

/**
 * ContextBuildInput
 * 构建单次模型上下文所需的完整输入：
 */
export interface ContextBuildInput {
    /** Agent 的固定身份、行为规则和安全约束 */
    systemPrompt?: string;
    /** AgentLoop 保存的完整会话历史，ContextManager 不得修改 */
    messages: readonly AgentMessage[];
    /** 当前允许模型调用的 Tool Schema */
    tools: readonly ToolSchema[];
    /** 模型支持的最大上下文 Token 数 */
    maxContextTokens: number;
    /** 为模型本轮回答预留的 Token 数 */
    reservedOutputTokens: number;
}

/**
 * ContextManager 为单次模型请求生成的快照。
 */
export interface ContextSnapshot {
    systemPrompt?: string;
    messages: AgentMessage[];
    tools: ToolSchema[];
    /** 当前快照预计占用的输入 Token 数。 */
    estimatedInputTokens: number;
    /** 本次允许输入内容使用的最大 Token 数。 */
    availableInputTokens: number;
    /** 因 Token 预算不足而丢弃的历史消息数量。 */
    droppedMessageCount: number;
}

/** 一组必须一起保留或一起删除的消息。 */
export interface ContextMessageGroup {
    /**
     * 普通消息只有一条；Tool
     * Tool 交互包含 Assistant Tool Call 和对应的 Tool Result。
     */
    kind: "single" | "tool_exchange";
    /** 消息保持原始顺序，禁止在组内重新排序。 */
    messages: AgentMessage[];
    /** 该消息组预计占用的 Token 数。 */
    estimatedTokens: number | null;
    /** 当前用户消息等不可被预算算法删除的消息组。 */
    required: boolean;
}

/**
 * Token Counter 一次计数所需的完整输入。
 */
export interface ContextTokenCountInput {
    /** 需要计入预算的 System Prompt。 */
    systemPrompt?: string;
    /** 需要计入预算的消息。 */
    messages: readonly AgentMessage[];
    /** 需要计入预算的 Tool Schema。 */
    tools: readonly ToolSchema[];
}

/**
 * 与具体模型厂商无关的 Token 计数接口。
 */
export interface ContextTokenCounter {
    /** 计算一次完整模型输入预计占用的 Token。 */
    count(input: ContextTokenCountInput): Promise<number>;
}

/**
 * 为单次模型请求构建上下文快照的能力。
 */
export interface ContextBuilder {
    /** 根据完整历史和 Token 预算生成请求快照。 */
    build(input: ContextBuildInput): Promise<ContextSnapshot>;
}
