import type { Tool, ToolResult } from '../types.js';
import type { QaPair } from './split.js';
import type { ContentDiagnosis } from './analyze_content.js';
import type { SpeechDiagnosis } from './analyze_speech.js';
import type { UserProfile } from '../../user-profile/userProfile.js';
import {
    generateImprovementPlan,
    findTopRecurring
} from '../../utils/reportUtils.js';

interface ReportInput {
    qaPairs: QaPair[];
    contentDiagnoses: ContentDiagnosis[];
    speechDiagnoses?: SpeechDiagnosis[];
    userProfile?: UserProfile;
}

interface DiagnosisReport {
    summary: {
        totalQuestions: number;
        overallScore: number;
        contentAvg: number;
        speechAvg?: number;
        topStrengths: string[];
        topWeaknesses: string[];
    };
    perQuestion: Array<{
        index: number;
        question: string;
        contentScore: number;
        speechScore?: number;
        keyIssue: string;
    }>;
    improvementPlan: {
        immediate: string[];      // 立即可改的
        shortTerm: string[];      // 1-2 周内提升的
        longTerm: string[];       // 需要持续积累的
    };
    comparedToLast?: {
        scoreChange: number;
        improvedDimensions: string[];
        declinedDimensions: string[];
    };
}

export const generateReportTool: Tool<ReportInput, DiagnosisReport> = {
    name: 'generate_report',
    description: '汇总所有题目的诊断结果，生成结构化的面试诊断报告。包含总分、分题得分、强弱项和改进路径。',
    parameters: {
        type: 'object',
        properties: {
            qaPairs: { type: 'array', description: '所有题目的 Q&A 对' },
            contentDiagnoses: { type: 'array', description: '每题的内容诊断结果' },
            speechDiagnoses: { type: 'array', description: '每题的语音诊断结果（可选）' },
            userProfile: { type: 'object', description: '用户画像（可选，用于对比进步）' },
        },
        required: ['qaPairs', 'contentDiagnoses'],
    },

    async execute(input, ctx): Promise<ToolResult<DiagnosisReport>> {
        const { qaPairs, contentDiagnoses, speechDiagnoses, userProfile } = input;

        // 计算汇总统计
        const contentScores = contentDiagnoses.map(d => d.overallScore);
        const contentAvg = Math.round(contentScores.reduce((a, b) => a + b, 0) / contentScores.length);

        let speechAvg: number | undefined;
        if (speechDiagnoses?.length) {
            const speechScores = speechDiagnoses.map(d => d.overallScore);
            speechAvg = Math.round(speechScores.reduce((a, b) => a + b, 0) / speechScores.length);
        }

        const overallScore = speechAvg
            ? Math.round(contentAvg * 0.75 + speechAvg * 0.25)
            : contentAvg;

        // 提取共性强项和弱项
        const allStrengths = contentDiagnoses.flatMap(d => d.strengths);
        const allMissing = contentDiagnoses.flatMap(d => d.keyMissing);
        const topStrengths = findTopRecurring(allStrengths, 3);
        const topWeaknesses = findTopRecurring(allMissing, 3);

        // 分题摘要
        const perQuestion = qaPairs.map((qa, i) => ({
            index: qa.index,
            question: qa.question.slice(0, 80),
            contentScore: contentDiagnoses[i]?.overallScore ?? 0,
            speechScore: speechDiagnoses?.[i]?.overallScore,
            keyIssue: contentDiagnoses[i]?.keyMissing[0] ?? '无明显问题',
        }));

        // 改进计划（调用 LLM 生成）
        const improvementPlan = await generateImprovementPlan(
            topWeaknesses, contentDiagnoses, ctx.queryEngine
        );

        // 与历史对比
        let comparedToLast: DiagnosisReport['comparedToLast'];
        if (userProfile?.lastDiagnosisScore) {
            comparedToLast = {
                scoreChange: overallScore - userProfile.lastDiagnosisScore,
                improvedDimensions: [],
                declinedDimensions: [],
            };
        }

        return {
            success: true,
            data: {
                summary: { totalQuestions: qaPairs.length, overallScore, contentAvg, speechAvg, topStrengths, topWeaknesses },
                perQuestion,
                improvementPlan,
                comparedToLast,
            },
        };
    },
};