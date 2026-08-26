import type { ContextDiff, ContextDiffGroup } from "./types.js";

type ContextPayload = {
    messages?: unknown;
    estimatedInputTokens?: unknown;
    availableInputTokens?: unknown;
    maxContextTokens?: unknown;
    reservedOutputTokens?: unknown;
};

/**
 * 比较 Context 前后消息。带 Tool Call 的 assistant 与其连续 Tool Result
 * 先聚合，再判断是否被裁剪，避免在界面上展示半个 Tool 交换。
 */
export function createContextDiff(before: unknown, after: unknown): ContextDiff {
    const beforePayload = asContextPayload(before);
    const afterPayload = asContextPayload(after);
    const beforeMessages = asMessages(beforePayload.messages);
    const afterMessages = asMessages(afterPayload.messages);
    const beforeGroups = groupMessages(beforeMessages);
    const afterGroupCounts = countGroups(groupMessages(afterMessages));
    const removedGroups = beforeGroups.filter((group) => {
        const key = stableJson(group.messages);
        const remaining = afterGroupCounts.get(key) ?? 0;
        if (remaining === 0) return true;
        afterGroupCounts.set(key, remaining - 1);
        return false;
    });

    return {
        before: beforeMessages,
        after: afterMessages,
        removedGroups,
        beforeMessageCount: beforeMessages.length,
        afterMessageCount: afterMessages.length,
        ...numberField("beforeEstimatedInputTokens", beforePayload.estimatedInputTokens),
        ...numberField("afterEstimatedInputTokens", afterPayload.estimatedInputTokens),
        ...numberField("beforeAvailableInputTokens", beforePayload.availableInputTokens),
        ...numberField("afterAvailableInputTokens", afterPayload.availableInputTokens),
        ...numberField("beforeMaxContextTokens", beforePayload.maxContextTokens),
        ...numberField("afterMaxContextTokens", afterPayload.maxContextTokens),
        ...numberField("beforeReservedOutputTokens", beforePayload.reservedOutputTokens),
        ...numberField("afterReservedOutputTokens", afterPayload.reservedOutputTokens),
    };
}

function asContextPayload(value: unknown): ContextPayload {
    return isRecord(value) ? value : {};
}

function asMessages(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function groupMessages(messages: unknown[]): ContextDiffGroup[] {
    const groups: ContextDiffGroup[] = [];

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const callIds = toolCallIds(message);
        if (callIds.length === 0) {
            groups.push({ kind: "single", messages: [message] });
            continue;
        }

        const results: unknown[] = [];
        const receivedIds = new Set<string>();
        let cursor = index + 1;
        while (cursor < messages.length) {
            const resultId = matchingToolResultId(messages[cursor], callIds, receivedIds);
            if (resultId === undefined) break;
            receivedIds.add(resultId);
            results.push(messages[cursor]);
            cursor += 1;
        }

        // Runtime 正常情况下这里是完整的匹配交换；异常记录也保留为一组，
        // 以免裁剪视图把已经出现的 Tool Result 与它的 Call 拆开。
        groups.push({ kind: "tool_exchange", messages: [message, ...results] });
        index = cursor - 1;
    }

    return groups;
}

function toolCallIds(message: unknown): string[] {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.toolCalls)) {
        return [];
    }
    const ids = message.toolCalls
        .filter(isRecord)
        .map((call) => call.id)
        .filter((id): id is string => typeof id === "string");
    return ids.length === message.toolCalls.length && new Set(ids).size === ids.length ? ids : [];
}

function matchingToolResultId(message: unknown, callIds: string[], receivedIds: Set<string>): string | undefined {
    if (!isRecord(message) || message.role !== "tool" || typeof message.toolCallId !== "string") {
        return undefined;
    }
    if (!callIds.includes(message.toolCallId) || receivedIds.has(message.toolCallId)) {
        return undefined;
    }
    return message.toolCallId;
}

function countGroups(groups: ContextDiffGroup[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const group of groups) {
        const key = stableJson(group.messages);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

/** 结构比较使用键排序 JSON，避免对象字段插入顺序影响裁剪结果。 */
function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (isRecord(value)) {
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? String(value);
}

function numberField<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
    return typeof value === "number" ? ({ [key]: value } as Record<Key, number>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
