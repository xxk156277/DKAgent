// 这是最核心的 Tool
// 调用 LLM 对比用户回答和参考答案，输出结构化诊断。

import type { Tool, ToolResult } from '../types.js';
import type { KBResult } from './knowledge-base.js';

export interface AnalyzeInput {
    question: string;
    userAnswer: string;
    referenceAnswers: KBResult[];
    // 可选的额外评分标准，允许用户提供自定义的评分维度或权重
    rubric?: string;
}


// - completeness: 是否覆盖了所有关键点
// - depth: 是否有递进分析，不只是表面描述
// - accuracy: 技术细节是否正确
// - practicality: 是否有实际经验支撑

export interface ContentDiagnosis {

    overallScore: number;           // 0-100
    dimensions: {
        completeness: { score: number; detail: string };
        depth: { score: number; detail: string };
        accuracy: { score: number; detail: string };
        practicality: { score: number; detail: string };
    };
    keyMissing: string[];           // 遗漏的关键点
    inaccuracies: string[];         // 技术错误
    strengths: string[];            // 做得好的地方
    improvementPlan: string;        // 具体改进建议
}

export const analyzeContentTool: Tool<AnalyzeInput, ContentDiagnosis> = {
    name: 'analyze_content',
    description: '对比用户的面试回答与知识库参考答案，从完整性、深度、准确性、实践性四个维度诊断内容质量。',
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: '面试问题' },
            userAnswer: { type: 'string', description: '用户的回答' },
            referenceAnswers: {
                type: 'array',
                description: '知识库中的参考答案',
                items: { type: 'object' },
            },
            rubric: { type: 'string', description: '额外的评分标准（可选）' },
        },
        required: ['question', 'userAnswer', 'referenceAnswers'],
    },
    execute: async (input, ctx): Promise<ToolResult<ContentDiagnosis>> => {
        const {
            question,
            userAnswer,
            referenceAnswers,
            rubric
        } = input;

        const systemPrompt = `你是一位资深技术面试官和诊断专家。你的任务是对比候选人的回答与参考答案，给出精确的结构化诊断。

评分维度（各 0-100）：
- completeness: 是否覆盖了所有关键点
- depth: 是否有递进分析，不只是表面描述
- accuracy: 技术细节是否正确
- practicality: 是否有实际经验支撑

输出格式为 JSON，严格遵循 schema。不要客气，直接指出问题。`;

        const userPrompt = `## 面试问题
${question}

## 候选人回答
${userAnswer}

## 参考答案（高手答）
${referenceAnswers.map((r, i) => `### 参考 ${i + 1}\n${r.expertAnswer}`).join('\n\n')}

${rubric ? `## 额外评分标准\n${rubric}` : ''}

请输出诊断结果（JSON）。`;

        const response = await ctx.queryEngine.query({
            task: 'diagnose_content',
            messages: [{ role: 'user', content: userPrompt }],
            systemPrompt,
            temperature: 0,
        });

        try {
            const diagnosis = JSON.parse(response.content ?? '{}') as ContentDiagnosis;
            return { success: true, data: diagnosis };
        } catch {
            return { success: false, error: { code: 'service_error', message: 'LLM 输出非法 JSON' } };
        }
    },
};