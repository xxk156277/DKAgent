import type { AgentMessage } from "../query-engine/provider.js";
import type { ContextMessageGroup } from "./types.js";

/**
 * 将完整消息历史转换为不可拆分的消息组。
 *
 * 普通消息单独成组；
 * Assistant Tool Call 与对应 Tool Result 组成一个完整组。
 */
export function groupContextMessages(
    messages: readonly AgentMessage[],
): ContextMessageGroup[] {

    const groups: ContextMessageGroup[] = [];
    const latestUserIndex = findLatestUserIndex(messages);

    let index = 0;

    while (index < messages.length) {
        const message = messages[index];

        if (!message) {
            break;
        }

        // Tool Result 必须跟在包含对应 Tool Call 的 Assistant 消息后面。
        if (message.role === "tool") {
            throw new Error(
                `发现孤立 Tool Result：${message.toolCallId}`,
            );
        }

        if (
            message.role === "assistant" &&
            message.toolCalls &&
            message.toolCalls.length > 0
        ) {
            const result = collectToolExchange(
                messages,
                index,
                latestUserIndex,
            );

            groups.push(result.group);
            index = result.nextIndex;
            continue;
        }

        groups.push({
            kind: "single",
            messages: [message],
            required:
                latestUserIndex >= 0 &&
                index >= latestUserIndex,
            estimatedTokens: null
        });

        index += 1;
    }

    return groups;
}

/**
 * 找到当前会话中最后一条 User 消息。
 * 该消息以及它后面的消息，都属于当前 Agent Run。
 */
function findLatestUserIndex(
    messages: readonly AgentMessage[],
): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
            return i;
        }
    }
    return -1;
}

/**
 * 收集一个完整的 Assistant Tool Call 和 Tool Result 消息组。
 */
function collectToolExchange(
    messages: readonly AgentMessage[],
    assistantIndex: number,
    latestUserIndex: number,
): {
    group: ContextMessageGroup;
    nextIndex: number;
} {
    const assistantMessage = messages[assistantIndex];

    if (
        !assistantMessage ||
        assistantMessage.role !== "assistant" ||
        !assistantMessage.toolCalls?.length
    ) {
        throw new Error("Tool 交互必须从 Assistant Tool Call 开始");
    }

    const expectedIds = new Set<string>();

    for (const call of assistantMessage.toolCalls) {
        if (expectedIds.has(call.id)) {
            throw new Error(
                `Assistant 包含重复 Tool Call ID：${call.id}`,
            );
        }

        expectedIds.add(call.id);
    }

    const receivedIds = new Set<string>();
    const groupMessages: AgentMessage[] = [
        assistantMessage,
    ];

    let nextIndex = assistantIndex + 1;

    // 只消费紧跟在 Assistant 后面的连续 Tool Result。
    while (nextIndex < messages.length) {
        const message = messages[nextIndex];

        if (!message || message.role !== "tool") {
            break;
        }

        if (!expectedIds.has(message.toolCallId)) {
            throw new Error(
                `Tool Result 没有对应 Tool Call：${message.toolCallId}`,
            );
        }

        if (receivedIds.has(message.toolCallId)) {
            throw new Error(
                `Tool Result 重复：${message.toolCallId}`,
            );
        }

        receivedIds.add(message.toolCallId);
        groupMessages.push(message);
        nextIndex += 1;
    }

    const missingIds = [...expectedIds].filter(
        (id) => !receivedIds.has(id),
    );

    if (missingIds.length > 0) {
        throw new Error(
            `Tool Call 缺少对应结果：${missingIds.join(", ")}`,
        );
    }

    return {
        group: {
            kind: "tool_exchange",
            messages: groupMessages,
            required:
                latestUserIndex >= 0 &&
                assistantIndex >= latestUserIndex,
            // Grouper 只负责结构，具体 Token 由 ContextManager 填入。
            estimatedTokens: null,
        },
        nextIndex,
    };
}
