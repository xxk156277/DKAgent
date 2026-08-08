// knowledge/import.ts

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { KnowledgeEntry } from './types.js'

interface DimensionConfig {
    dir: string;
    id: string;
    label: string;
}

const DIMENSIONS: DimensionConfig[] = [
    { dir: '01-architecture-design', id: 'architecture-design', label: '架构选型' },
    { dir: '02-tool-management', id: 'tool-management', label: '工具管理' },
    { dir: '03-fault-tolerance', id: 'fault-tolerance', label: '容错与兜底' },
    { dir: '04-memory-context', id: 'memory-context', label: '记忆与上下文' },
    { dir: '05-eval-and-vision', id: 'eval-and-vision', label: '评估与愿景' },
    { dir: '06-multi-agent-collab', id: 'multi-agent-collab', label: '多Agent协作' },
    { dir: '07-engineering-pitfalls', id: 'engineering-pitfalls', label: '工程踩坑' },
    { dir: '08-prompt-engineering', id: 'prompt-engineering', label: 'Prompt工程' },
    { dir: '09-rag-retrieval', id: 'rag-retrieval', label: 'RAG检索' },
    { dir: '10-training-and-data', id: 'training-and-data', label: '训练与数据' },
    { dir: '11-ai-code-testing', id: 'ai-code-testing', label: 'AI代码测试' },
    { dir: '12-business-ai-engineering', id: 'business-ai-engineering', label: '业务AI工程' },
    { dir: '13-project-deep-dive', id: 'project-deep-dive', label: '项目深挖' },
    { dir: '15-agent-concepts', id: 'agent-concepts', label: 'Agent概念' },
];

export function importAll(interviewDir: string): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];

    for (const dim of DIMENSIONS) {
        const filePath = join(interviewDir, dim.dir, 'index.md');
        const content = readFileSync(filePath, 'utf-8');
        const questions = parseMarkdown(content, dim);
        entries.push(...questions);
    }

    console.log(`Imported ${entries.length} entries from ${DIMENSIONS.length} dimensions`);
    return entries;
}

function parseMarkdown(content: string, dim: DimensionConfig): KnowledgeEntry[] {
    const entries: KnowledgeEntry[] = [];

    // 按 Q 标题分割（支持 ## Q 和 ### Q）
    const sections = content.split(/(?=^#{2,3}\s*Q[：:])/m);
    let index = 0;

    for (const section of sections) {
        if (!section.match(/^#{2,3}\s*Q[：:]/m)) continue;
        index++;

        const entry = parseQuestion(section, dim, index);
        if (entry) entries.push(entry);
    }

    return entries;
}

function parseQuestion(
    section: string,
    dim: DimensionConfig,
    index: number
): KnowledgeEntry | null {
    // 提取问题
    const questionMatch = section.match(/^#{2,3}\s*Q[：:]\s*(.+)/m);
    if (!questionMatch) return null;
    const question = questionMatch[1].trim();

    // 提取来源
    const sourceMatch = section.match(/>\s*来源[：:]\s*(.+)/);
    const source = sourceMatch?.[1]?.trim();

    // 提取新手答
    const noviceMatch = section.match(/\*\*新手答\*\*[：:]\s*["""]?(.+?)["""]?\s*$/m);
    const noviceAnswer = noviceMatch?.[1]?.trim() ?? '';

    // 提取高手答（从"**高手答**："到下一个"**"标记）
    const expertMatch = section.match(
        /\*\*高手答\*\*[：:]\s*\n([\s\S]+?)(?=\n\*\*(?:差距|考察|关键))/
    );
    const expertAnswer = expertMatch?.[1]?.trim() ?? '';

    // 提取差距分析
    const gapMatch = section.match(
        /\*\*(?:差距在哪|考察点|关键差距)\*\*[：:]\s*([\s\S]+?)(?=\n---|\n#{2,3}\s|$)/
    );
    const gapAnalysis = gapMatch?.[1]?.trim() ?? '';

    if (!expertAnswer) return null;

    // 提取关键词
    const keywords = extractKeywords(question + ' ' + expertAnswer);

    return {
        id: `${dim.id}:${index}`,
        dimension: dim.id,
        dimensionLabel: dim.label,
        question,
        source,
        noviceAnswer,
        expertAnswer,
        gapAnalysis,
        keywords,
    };
}

function extractKeywords(text: string): string[] {
    // 提取技术术语（英文词 + 中文专有名词）
    const techTerms = text.match(
        /\b(?:ReAct|LangGraph|RAG|CoT|ToT|Agent|Tool|MCP|embedding|vector|prompt|token|LLM|fine-?tune|RLHF|hallucination|context|memory|planning|reflection)\b/gi
    ) ?? [];

    // 去重 + 小写化
    return [...new Set(techTerms.map(t => t.toLowerCase()))];
}