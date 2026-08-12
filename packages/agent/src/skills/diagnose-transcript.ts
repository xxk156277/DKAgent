// skills/diagnose-transcript.ts
import type { Skill, SkillOutput, } from "./types.js";

export const diagnoseTranscriptSkill: Skill = {
    name: 'diagnose-transcript',
    description: '从面试文字稿完成全流程诊断：拆题 → 逐题检索知识库 → 逐题诊断 → 生成报告',
    triggers: [
        '诊断',
        '分析面试',
        '帮我看看',
        '面试稿',
        'diagnose'
    ],
    requiredTools: [
        'split_qa_pairs',
        'query_knowledge_base',
        'analyze_content',
        'generate_report'
    ],
    execute: async (input, ctx): Promise<SkillOutput> => {
        const {
            toolRegistry,
            queryEngine,
            session,
            hooks
        } = ctx;

        const transcript = input.rawInput;

        // Step 1: 拆分 Q&A
        const splitTool = toolRegistry.resolve('split_qa_pairs');
        const splitResult = await splitTool.execute(
            { transcript, format: 'auto' },
            {
                session,
                queryEngine,
                knowledgeBase: null!,
                abortSignal: session.abortController.signal
            }
        );

        if (!splitResult.success) {
            return {
                success: false,
                error: `拆题失败: ${splitResult.error?.message}`
            };
        }

        const pairs = splitResult.data!.pairs;
        const contentDiagnoses: ContentDiagnosis[] = [];

        // Step 2 & 3: 逐题检索 + 诊断
        for (const pair of pairs) {
            // 检索知识库
            const kbTool = toolRegistry.resolve('query_knowledge_base');
            const kbResult = await kbTool.execute(
                {
                    question: pair.question,
                    limit: 3
                },
                {
                    session,
                    queryEngine,
                    knowledgeBase: ctx.knowledgeBase,
                    abortSignal: session.abortController.signal
                }
            );

            const references = kbResult.success
                ? kbResult.data!.results
                : [];

            // 诊断内容
            const diagTool = toolRegistry.resolve('analyze_content');
            const diagResult = await diagTool.execute(
                {
                    question: pair.question,
                    userAnswer: pair.answer,
                    referenceAnswers: references
                },
                {
                    session, queryEngine,
                    knowledgeBase: null!,
                    abortSignal: session.abortController.signal
                }
            );

            if (diagResult.success) {
                contentDiagnoses.push(diagResult.data!);
            }

            // 更新进度
            session.updateProgress(pair.index, pairs.length);
        }

        // Step 4: 生成报告
        const reportTool = toolRegistry.resolve('generate_report');
        const reportResult = await reportTool.execute(
            { qaPairs: pairs, contentDiagnoses },
            { session, queryEngine, knowledgeBase: null!, abortSignal: session.abortController.signal }
        );

        if (!reportResult.success) {
            return { success: false, error: '报告生成失败' };
        }

        return {
            success: true,
            result: reportResult.data,
            report: formatReportForUser(reportResult.data!),
        };
    },
};