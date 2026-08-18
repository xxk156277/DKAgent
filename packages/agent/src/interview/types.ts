export type InterviewSpeaker = "interviewer" | "candidate";

export interface TranscriptTurn {
    id: string;
    speaker: InterviewSpeaker;
    speakerLabel: string;
    timestamp?: string;
    content: string;
    sourceStart: number;
    sourceEnd: number;
}

export interface ParsedTranscript {
    source: string;
    turns: TranscriptTurn[];
}

export interface TranscriptCorrection {
    turnId: string;
    original: string;
    replacement: string;
    confidence: number;
    reason: string;
}

export interface TranscriptSegment {
    turnId: string;
    text: string;
}

export type InterviewQuestionType =
    | "project"
    | "knowledge"
    | "open"
    | "behavior"
    | "coding"
    | "procedural";

export interface InterviewQuestion {
    id: string;
    clusterId: string;
    promptTurnIds: string[];
    promptSegments: TranscriptSegment[];
    answerTurnIds: string[];
    originalQuestion: string;
    originalAnswer: string;
    questionType: InterviewQuestionType;
    scored: boolean;
    sourceStart: number;
    sourceEnd: number;
}

export interface QuestionCluster {
    id: string;
    title: string;
    questionIds: string[];
}

export interface StructuredInterview {
    transcript: ParsedTranscript;
    corrections: TranscriptCorrection[];
    questions: InterviewQuestion[];
    clusters: QuestionCluster[];
    nonQuestionTurnIds: string[];
}
