import type {
    LLMProvider,
    ModelRequest,
    ModelResponse,
} from "./provider.js";
import { parseModelStream } from "./stream-parser.js";
import { Tracer } from "@dkagent/trace";
import type { JsonValue, SpanInputMap, SpanOutputMap } from "@dkagent/trace";

/**
 * 一次模型调用的编排入口。
 *
 * Context 选择和 Tool 执行分别属于 ContextManager 与 AgentLoop。
 */
export class QueryEngine {
    public constructor(
        private readonly provider: LLMProvider,
        private readonly tracer = new Tracer(),
    ) {}

    public getTracer(): Tracer {
        return this.tracer;
    }

    /** 发送请求并把 Provider Stream 组装成统一响应。 */
    public query(request: ModelRequest): Promise<ModelResponse> {
        const traceRequest: SpanInputMap["model.generate"] = {
            provider: this.provider.name,
            model: request.model,
            messages: request.messages as unknown as JsonValue[],
            ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
            ...(request.tools === undefined ? {} : { tools: request.tools as unknown as JsonValue[] }),
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(request.responseFormat === undefined ? {} : { responseFormat: request.responseFormat }),
            ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
        };
        return this.tracer.span("model.generate", traceRequest, async (span) => {
            const response = await parseModelStream(
                this.provider.stream(request),
                request.onTextDelta,
            );
            span.setTokenUsage(response.usage);
            if (response.type === "text") {
                const output: SpanOutputMap["model.generate"] = { type: "text", content: response.content, stopReason: response.stopReason };
                span.setOutput(output);
            } else {
                const output: SpanOutputMap["model.generate"] = {
                    type: "tool_use", ...(response.content === undefined ? {} : { content: response.content }),
                    toolCalls: response.toolCalls as unknown as JsonValue[], stopReason: response.stopReason,
                };
                span.setOutput(output);
            }
            return response;
        });
    }
}

/** 旧名称兼容别名，调用方迁移后统一使用 ModelRequest。 */
export type QueryParams = ModelRequest;
