import type { Tool, ToolResult } from '../types.js';

interface SpeechInput {
    audioSegmentPath: string;
    transcript: string;
    timestamps: Array<{ start: number; end: number; text: string }>;
}

export interface SpeechDiagnosis {
    overallScore: number;
    metrics: {
        fluency: { score: number; wordsPerMinute: number; detail: string };
        pace: { score: number; avgPauseMs: number; detail: string };
        confidence: { score: number; fillerCount: number; detail: string };
        rhythm: { score: number; longPauses: number; detail: string };
    };
    fillerWords: Array<{ word: string; count: number; timestamps: number[] }>;
    longPauses: Array<{ startMs: number; durationMs: number }>;
    suggestion: string;
}

export const analyzeSpeechTool: Tool<SpeechInput, SpeechDiagnosis> = {
    name: 'analyze_speech',
    description: '分析面试回答的语音特征：语速、停顿、填充词（嗯/那个/就是）、节奏感。需要带时间戳的转写结果。',
    parameters: {
        type: 'object',
        properties: {
            audioSegmentPath: {
                type: 'string',
                description: '音频片段文件路径'
            },
            transcript: {
                type: 'string',
                description: '该片段的转写文本'
            },
            timestamps: {
                type: 'array',
                description: '带时间戳的逐句转写',
                items: {
                    type: 'object',
                    properties: {
                        start: { type: 'number' },
                        end: { type: 'number' },
                        text: { type: 'string' },
                    },
                },
            },
        },
        required: ['transcript', 'timestamps'],
    },

    async execute(input, ctx): Promise<ToolResult<SpeechDiagnosis>> {
        const { transcript, timestamps } = input;

        // 时间戳不足时无法计算，直接返回错误
        const first = timestamps[0];
        const last = timestamps[timestamps.length - 1];
        if (!first || !last) {
            return {
                success: false,
                error: { code: 'input_error', message: '时间戳数据不足，无法分析语音' },
            };
        }

        // 基于时间戳的计算——不需要 LLM
        const totalDurationMs = last.end - first.start;
        const totalWords = transcript.split(/\s+/).length;
        const wordsPerMinute = Math.round((totalWords / totalDurationMs) * 60000);

        // 填充词检测
        const fillerPatterns = ['嗯', '那个', '就是', '然后', '这个', '额', 'um', 'uh', 'like'];
        const fillerWords = detectFillers(transcript, timestamps, fillerPatterns);
        const fillerCount = fillerWords.reduce((sum, f) => sum + f.count, 0);

        // 停顿检测：相邻句之间 gap > 2000ms
        const longPauses = detectLongPauses(timestamps, 2000);

        // 评分
        const fluencyScore = calculateFluencyScore(wordsPerMinute, fillerCount, totalWords);
        const paceScore = calculatePaceScore(timestamps);
        const confidenceScore = Math.max(0, 100 - fillerCount * 8);
        const rhythmScore = Math.max(0, 100 - longPauses.length * 15);

        const overallScore = Math.round(
            fluencyScore * 0.3 + paceScore * 0.2 + confidenceScore * 0.3 + rhythmScore * 0.2
        );

        return {
            success: true,
            data: {
                overallScore,
                metrics: {
                    fluency: { score: fluencyScore, wordsPerMinute, detail: fluencyDetail(wordsPerMinute) },
                    pace: { score: paceScore, avgPauseMs: avgPause(timestamps), detail: paceDetail(paceScore) },
                    confidence: { score: confidenceScore, fillerCount, detail: confidenceDetail(fillerCount) },
                    rhythm: { score: rhythmScore, longPauses: longPauses.length, detail: rhythmDetail(longPauses.length) },
                },
                fillerWords,
                longPauses,
                suggestion: generateSpeechSuggestion(overallScore, fillerWords, longPauses),
            },
        };
    },
};

function detectFillers(
    transcript: string,
    timestamps: Array<{ start: number; end: number; text: string }>,
    patterns: string[],
): Array<{ word: string; count: number; timestamps: number[] }> {
    return patterns.map(word => {
        const hits: number[] = [];
        for (const seg of timestamps) {
            if (seg.text.includes(word)) {
                hits.push(seg.start);
            }
        }
        return { word, count: hits.length, timestamps: hits };
    }).filter(f => f.count > 0);
}

function detectLongPauses(
    timestamps: Array<{ start: number; end: number }>,
    thresholdMs: number,
): Array<{ startMs: number; durationMs: number }> {
    const pauses: Array<{ startMs: number; durationMs: number }> = [];
    for (let i = 1; i < timestamps.length; i++) {
        const prev = timestamps[i - 1];
        const curr = timestamps[i];
        if (!prev || !curr) continue; // 防御性检查：索引越界时跳过（正常不会发生）
        const gap = curr.start - prev.end;
        if (gap > thresholdMs) {
            pauses.push({ startMs: prev.end, durationMs: gap });
        }
    }
    return pauses;
}