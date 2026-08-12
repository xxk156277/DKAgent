// tools/knowledge-base.ts
import type { Tool, ToolResult } from '../types.js';

interface KBQueryInput {
    question: string;
    dimension?: string;
    limit?: number;
}

export interface KBResult {
    // 原始问题文本
    question: string;
    // 高手回答文本
    noviceAnswer: string;
    // 新手回答文本
    expertAnswer: string;
    // 差距分析 
    gap: string;
    // 检索结果的维度
    dimension: string;
    // 相似度分数，范围 [0, 1]
    similarity: number;
}

interface KBQueryOutput {
    results: KBResult[];
    totalMatched: number;
}

export const knowledgeBaseTool: Tool<KBQueryInput, KBQueryOutput> = {
    name: 'query_knowledge_base',
    description: '从面试知识库中检索与给定问题最相关的参考答案。返回高手答、新手答和差距分析。',
    parameters: {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: '要检索的面试问题'
            },
            dimension: {
                type: 'string',
                description: '限定检索的维度（可选）',
                enum: [
                    'agent-basic',
                    'tool-calling',
                    'memory',
                    'planning',
                    'multi-agent',
                    'engineering',
                    'model-capability'
                ],
            },
            limit: {
                type: 'number',
                description: '返回结果数量，默认3',
                minimum: 1,
                maximum: 10
            },
        },
        required: ['question'],
    },
    execute: async (input, ctx): Promise<ToolResult<KBQueryOutput>> => {
        const { question, dimension, limit = 3 } = input;
        const kb = ctx.knowledgeBase;

        // 双通道检索：FTS5 全文 + embedding 语义
        const ftsResults = kb.searchFTS(
            question,
            { dimension, limit: limit * 2 }
        );

        const embeddingResults = await kb.searchEmbedding(
            question,
            { dimension, limit: limit * 2 }
        );

        // 合并去重 + 重排序
        const merged = mergeAndRank(ftsResults, embeddingResults, limit);

        return {
            success: true,
            data: {
                results: merged,
                totalMatched: merged.length
            },
        };
    },
};

function mergeAndRank(
    fts: KBResult[],
    embedding: KBResult[],
    limit: number
): KBResult[] {

    const seen = new Set<string>();
    const all: KBResult[] = [];

    for (const r of [...embedding, ...fts]) {
        const key = r.question.slice(0, 50);
        if (!seen.has(key)) {
            seen.add(key);
            all.push(r);
        }
    }

    // 按 similarity 降序
    return all.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}