export async function evaluateSearch(
    search: KnowledgeSearch,
    testCases: Array<{ query: string; expectedDimension: string; expectedKeywords: string[] }>,
): Promise<void> {
    let hits = 0;

    for (const tc of testCases) {
        const results = await search.search(tc.query, { limit: 3 });

        const topResult = results[0];
        const dimensionMatch = topResult?.dimension === tc.expectedDimension;
        const keywordMatch = tc.expectedKeywords.some(kw =>
            topResult?.expertAnswer.includes(kw)
        );

        if (dimensionMatch || keywordMatch) hits++;

        console.log(`[${dimensionMatch ? '✓' : '✗'}] "${tc.query.slice(0, 40)}..." → ${topResult?.dimension ?? 'NO RESULT'} (sim: ${topResult?.similarity.toFixed(3) ?? 'N/A'})`);
    }

    console.log(`\nAccuracy: ${hits}/${testCases.length} (${(hits / testCases.length * 100).toFixed(1)}%)`);
}

// 测试用例示例
const TEST_CASES = [
    { query: 'Agent 的记忆系统怎么设计', expectedDimension: 'memory-context', expectedKeywords: ['长短期', 'memory'] },
    { query: 'ReAct 和 Plan-and-Execute 怎么选', expectedDimension: 'architecture-design', expectedKeywords: ['ReAct', 'Plan'] },
    { query: 'RAG 检索质量怎么提升', expectedDimension: 'rag-retrieval', expectedKeywords: ['chunk', 'embedding', 'rerank'] },
    { query: '多 Agent 之间怎么通信', expectedDimension: 'multi-agent-collab', expectedKeywords: ['消息', '协议'] },
    { query: 'Tool 调用失败了怎么兜底', expectedDimension: 'fault-tolerance', expectedKeywords: ['重试', 'fallback'] },
];