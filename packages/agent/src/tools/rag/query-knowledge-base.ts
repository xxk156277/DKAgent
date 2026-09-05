import type { RagQueryResult } from "@dkagent/rag-v2";
import type { Tool } from "../types.js";

/** Agent Tool 依赖的最小只读端口，测试可使用内存 Fake。 */
export interface KnowledgeRetriever {
    query(query: string, topK: number): Promise<RagQueryResult>;
}

export interface QueryKnowledgeBaseInput {
    query: string;
    topK?: number | undefined;
}

export interface QueryKnowledgeBaseOutput extends RagQueryResult {
    query: string;
}

/** 创建供 Agent 主动调用的大康 Note 知识库检索 Tool。 */
export function createQueryKnowledgeBaseTool(
    retriever: KnowledgeRetriever,
): Tool<QueryKnowledgeBaseInput, QueryKnowledgeBaseOutput> {
    return {
        name: "query_knowledge_base",
        description: [
            "搜索已索引的大康 Note 私有知识库。",
            "当问题涉及用户笔记、项目知识或需要可追溯证据时调用；",
            "返回的 [n] 路径#标题是证据引用，若没有证据必须明确不知道。",
        ].join(""),
        parameters: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    minLength: 1,
                    description: "要在知识库中检索的完整问题",
                },
                topK: {
                    type: "integer",
                    minimum: 1,
                    maximum: 5,
                    default: 3,
                    description: "返回的父文档数量，默认 3",
                },
            },
        },
        async execute(input, context) {
            const query = typeof input?.query === "string" ? input.query.trim() : "";
            const topK = input?.topK ?? 3;
            if (!query) {
                return {
                    success: false,
                    error: { code: "input_error", message: "query 必须是非空字符串" },
                };
            }
            if (!Number.isInteger(topK) || topK < 1 || topK > 5) {
                return {
                    success: false,
                    error: { code: "input_error", message: "topK 必须是 1 到 5 的整数" },
                };
            }
            if (context.abortSignal.aborted) {
                return {
                    success: false,
                    error: { code: "timeout", message: "知识库检索已中止" },
                };
            }

            try {
                const result = await retriever.query(query, topK);
                if (context.abortSignal.aborted) {
                    return {
                        success: false,
                        error: { code: "timeout", message: "知识库检索已中止" },
                    };
                }
                return {
                    success: true,
                    data: { query, ...result },
                };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    success: false,
                    error: { code: "service_error", message: `知识库检索失败：${message}` },
                };
            }
        },
    };
}
