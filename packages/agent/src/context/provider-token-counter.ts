import type {
    AgentMessage,
    ToolSchema,
} from "../query-engine/provider.js";
import type {
    ContextTokenCountInput,
    ContextTokenCounter,
} from "./types.js";

/** Context 模块依赖的最小 Provider Token 计数能力。 */
export interface MessageTokenCounterPort {
    /** 计算消息和 Tool Schema 预计占用的 Token。 */
    countTokens(
        messages: AgentMessage[],
        tools?: ToolSchema[],
    ): Promise<number>;
}

/**
 * 把 Provider 的 countTokens 接口适配成 ContextTokenCounter。
 */
export class ProviderTokenCounter implements ContextTokenCounter {
    public constructor(
        private readonly port: MessageTokenCounterPort,
    ) {}

    /** 计算包含 System Prompt 的完整上下文输入 Token。 */
    public async count(input: ContextTokenCountInput): Promise<number> {
        // Provider 旧接口没有 systemPrompt 参数，计数时临时转为 System 消息。
        const messages: AgentMessage[] = input.systemPrompt === undefined
            ? [...input.messages]
            : [
                { role: "system", content: input.systemPrompt },
                ...input.messages,
            ];

        const tokenCount = await this.port.countTokens(
            messages,
            [...input.tools],
        );

        if (!Number.isInteger(tokenCount) || tokenCount < 0) {
            throw new Error(`Provider 返回了非法 Token 数：${tokenCount}`);
        }

        return tokenCount;
    }
}
