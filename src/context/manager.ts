import { groupContextMessages } from "./grouper.js";
import type {
    ContextBuilder,
    ContextBuildInput,
    ContextMessageGroup,
    ContextSnapshot,
    ContextTokenCounter,
} from "./types.js";

/**
 * 校验上下文和输出 Token 预算。
 */
function validateContextBudget(
    input: ContextBuildInput,
): void {
    if (
        !Number.isInteger(input.maxContextTokens) ||
        input.maxContextTokens <= 0
    ) {
        throw new Error(
            "maxContextTokens 必须是正整数",
        );
    }

    if (
        !Number.isInteger(
            input.reservedOutputTokens,
        ) ||
        input.reservedOutputTokens < 0
    ) {
        throw new Error(
            "reservedOutputTokens 必须是非负整数",
        );
    }

    if (
        input.reservedOutputTokens >=
        input.maxContextTokens
    ) {
        throw new Error(
            "reservedOutputTokens 必须小于 maxContextTokens",
        );
    }
}

/**
 * 根据 Token 预算构建单次模型请求的上下文快照。
 *
 * ContextManager 不保存会话状态，也不会修改 AgentLoop 的完整消息历史。
 */
export class ContextManager implements ContextBuilder {
    public constructor(
        private readonly tokenCounter: ContextTokenCounter,
    ) { }

    /**
     * 将完整历史转换成符合 Token 预算的请求快照。
     */
    public async build(
        input: ContextBuildInput,
    ): Promise<ContextSnapshot> {
        validateContextBudget(input);

        // 可用token数量
        const availableInputTokens =
            input.maxContextTokens -
            input.reservedOutputTokens;

        // 获取消息组
        const originalGroups = groupContextMessages(
            input.messages,
        );

        // 为调试和后续扩展记录每组消息的预计 Token。
        const measuredGroups = await this.measureGroups(
            originalGroups,
        );

        // 复制数组，后续删除不会影响原始分组结果。
        const selectedGroups = [...measuredGroups];

        let estimatedInputTokens =
            await this.countCompleteInput(
                input,
                selectedGroups,
            );

        // 预估消耗token>可用token
        // 循环删除，时间最元且允许删除的消息组，知道token满足
        while (
            estimatedInputTokens >
            availableInputTokens
        ) {
            // 分组顺序就是消息时间顺序，所以第一个可删除组最旧。
            const removableIndex =
                selectedGroups.findIndex(
                    (group) => !group.required,
                );

            if (removableIndex < 0) {
                throw new Error(
                    [
                        "必留上下文超过可用 Token 预算",
                        `可用：${availableInputTokens}`,
                        `需要：${estimatedInputTokens}`,
                    ].join("；"),
                );
            }

            // 一次删除整个组，避免拆散 Tool Call 和 Tool Result。
            selectedGroups.splice(
                removableIndex,
                1,
            );

            // 最终判断始终重新计算完整请求。
            estimatedInputTokens =
                await this.countCompleteInput(
                    input,
                    selectedGroups,
                );
        }

        // 遍历消息组，并把数组扁平化。
        // 相当于：map() + flat(1)
        const selectedMessages =
            selectedGroups.flatMap(
                (group) => group.messages,
            );

        return {
            ...(input.systemPrompt === undefined
                ? {}
                : {
                    systemPrompt:
                        input.systemPrompt,
                }),

            // 创建新数组，避免调用方修改原始历史数组。
            messages: [...selectedMessages],
            tools: [...input.tools],

            estimatedInputTokens,
            availableInputTokens,

            droppedMessageCount:
                input.messages.length -
                selectedMessages.length,
        };
    }

    /**
     * 为每个消息组补充独立 Token 估算。
     *
     * 该结果用于调试，不作为最终预算判断依据。
     */
    private async measureGroups(
        groups: ContextMessageGroup[],
    ): Promise<ContextMessageGroup[]> {
        return Promise.all(
            groups.map(async (group) => ({
                ...group,

                // 组内消息数组也创建副本。
                messages: [...group.messages],

                estimatedTokens:
                    await this.tokenCounter.count({
                        messages: group.messages,
                        tools: [],
                    }),
            })),
        );
    }

    /**
     * 计算一次完整模型请求的 Token。
     *
     * System Prompt 和 Tool Schema 只在这里计入，
     * 不重复分摊给每个消息组。
     */
    private countCompleteInput(
        input: ContextBuildInput,
        groups: ContextMessageGroup[],
    ): Promise<number> {
        const messages = groups.flatMap(
            (group) => group.messages,
        );

        return this.tokenCounter.count({
            ...(input.systemPrompt === undefined
                ? {}
                : {
                    systemPrompt:
                        input.systemPrompt,
                }),
            messages,
            tools: input.tools,
        });
    }
}
