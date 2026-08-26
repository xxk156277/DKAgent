import type { AgentMessage, ModelRequest, ModelResponse, ToolSchema } from "../query-engine/provider.js";

/**
 * ContextCompactionInput - 压缩器入参
 *      1.ConversationContextState - 历史压缩状态
 *          摘要、上次压缩的位置、上次压缩前预估token、上次压缩后token
 *      2.ContextCompactionOptions - 压缩配置
 *          开关、触发阈值、目标阈值、摘要阈值、ToolResult阈值
 *      3.压缩模型ID
 *      4.压缩停止器 AbortSignal
 *
 * HistorySummaryInput - 生成历史摘要 - 喂给模型的入参定义
 *      当前摘要Summary
 *      新加入摘要的历史会话
 *      摘要模型ID
 *      摘要的最大Token
 *      摘要前处理ToolResult的最大token
 *      摘要停止器
 *
 * HistorySummaryEngine - 摘要模型Provider
 *      query 请求方法
 *
 * ContextBuildInput - 构建上下文方法入参
 */
/**
 * 当前会话的历史压缩状态。
 *
 * 该状态由 AgentLoop 持有，只在当前进程、当前会话中有效；
 * ContextManager 只读取或返回新状态，不负责跨进程持久化。
 */
export interface ConversationContextState {
    /** 已被压缩的旧对话生成的结构化摘要；尚未压缩时为空字符串。 */
    summary: string;
    /**
     * 完整 messages 中第一条仍需保留原文的消息下标。
     * 该下标之前的消息已经包含在 summary 中。
     */
    firstKeptMessageIndex: number;
}

/** 历史摘要与内容压缩使用的配置。 */
export interface ContextCompactionOptions {
    /** 是否启用历史摘要；关闭后继续使用 Context V1 的直接裁剪策略。 */
    enabled: boolean;
    /** 输入占可用预算的比例达到该值时，触发历史压缩。 */
    triggerRatio: number;
    /** 压缩后期望把输入占用降低到可用预算的该比例。 */
    targetRatio: number;
    /** 单次历史摘要允许模型输出的最大 Token 数。 */
    maxSummaryTokens: number;
    /** Tool Result 进入摘要请求前允许保留的最大字符数。 */
    maxToolResultChars: number;
}

/** ContextManager 压缩前的入参 */
export interface ContextCompactionInput {
    /** 当前 AgentLoop 持有的会话压缩状态。 */
    state: ConversationContextState;
    /** 本次构建使用的压缩阈值和内容上限。 */
    options: ContextCompactionOptions;
    /** 执行历史摘要任务使用的模型 ID。 */
    summaryModel: string;
    /** 用于中止摘要模型请求。 */
    abortSignal?: AbortSignal;
}

/** 生成一次历史摘要所需的输入。 */
export interface HistorySummaryInput {
    /** 上一次压缩生成的摘要；第一次压缩时为空字符串。 */
    existingSummary: string;
    /** 本次新增进入摘要范围的原始历史消息。 */
    messages: readonly AgentMessage[];
    /** 执行摘要任务使用的模型 ID。 */
    model: string;
    /** 摘要结果允许模型输出的最大 Token 数。 */
    maxTokens: number;
    /** Tool Result 序列化给摘要模型前允许保留的最大字符数。 */
    maxToolResultChars: number;
    /** 用于中止本次摘要模型请求。 */
    abortSignal?: AbortSignal;
}

/** Compressor 调用摘要模型所依赖的最小端口。 */
export interface HistorySummaryEngine {
    /** 发送一次模型请求，并返回 Provider 中立的模型响应。 */
    query(request: ModelRequest): Promise<ModelResponse>;
}

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
    /** 可选的历史压缩配置；未传入时保持 Context V1 的直接裁剪行为。 */
    compaction?: ContextCompactionInput;
}

/**
 * ContextManager 为单次模型请求生成的快照。
 */
export interface ContextSnapshot {
    systemPrompt?: string;
    messages: AgentMessage[];
    tools: ToolSchema[];
    /** 本次构建完成后的会话压缩状态，供 AgentLoop 保存。 */
    nextContextState?: ConversationContextState;
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
