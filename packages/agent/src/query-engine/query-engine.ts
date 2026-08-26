import type { LLMProvider, ModelRequest, ModelResponse } from "./provider.js";
import { parseModelStream } from "./stream-parser.js";

/**
 * 一次模型调用的编排入口。
 *
 * Context 选择和 Tool 执行分别属于 ContextManager 与 AgentLoop。
 */
export class QueryEngine {
    public constructor(private readonly provider: LLMProvider) {}

    /** 发送请求并把 Provider Stream 组装成统一响应。 */
    public query(request: ModelRequest): Promise<ModelResponse> {
        return parseModelStream(this.provider.stream(request), request.onTextDelta);
    }
}

/** 旧名称兼容别名，调用方迁移后统一使用 ModelRequest。 */
export type QueryParams = ModelRequest;
