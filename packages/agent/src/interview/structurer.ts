import { z } from "zod";
import type { QueryEngine } from "../query-engine/query-engine.js";
import { queryModelJson } from "./model-json.js";
import type {
    InterviewQuestion,
    ParsedTranscript,
    QuestionCluster,
    TranscriptTurn,
} from "./types.js";

const promptSegmentSchema = z.object({
    turnId: z.string().min(1),
    text: z.string().min(1),
}).strict();

const questionRelationSchema = z.object({
    id: z.string().min(1),
    clusterId: z.string().min(1),
    promptSegments: z.array(promptSegmentSchema).min(1),
    answerTurnIds: z.array(z.string().min(1)),
    questionType: z.enum([
        "project",
        "knowledge",
        "open",
        "behavior",
        "coding",
        "procedural",
    ]),
    scored: z.boolean(),
}).strict();

const relationSchema = z.object({
    clusters: z.array(z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        questionIds: z.array(z.string().min(1)).min(1),
    }).strict()),
    questions: z.array(questionRelationSchema),
    nonQuestionTurnIds: z.array(z.string().min(1)),
}).strict();

interface StructureInput {
    transcript: ParsedTranscript;
    correctedTurns: TranscriptTurn[];
    queryEngine: QueryEngine;
    model: string;
    abortSignal: AbortSignal;
}

interface StructureOutput {
    questions: InterviewQuestion[];
    clusters: QuestionCluster[];
    nonQuestionTurnIds: string[];
}

function findDuplicates(values: string[]): string[] {
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function sameMembers(left: string[], right: string[]): boolean {
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.length === sortedRight.length
        && sortedLeft.every((value, index) => value === sortedRight[index]);
}

export async function structureInterview(input: StructureInput): Promise<StructureOutput> {
    const correctedById = new Map(
        input.correctedTurns.map((turn) => [turn.id, turn.content]),
    );
    const relation = await queryModelJson({
        queryEngine: input.queryEngine,
        model: input.model,
        abortSignal: input.abortSignal,
        schema: relationSchema,
        systemPrompt: [
            "把面试轮次映射为具体问题和问题簇，只返回 JSON。",
            "同一轮包含多个具体问题时必须拆成多题，每题返回原文中的精确片段。",
            "每个面试官轮次必须出现在至少一个 promptSegments 中，或列入 nonQuestionTurnIds。",
            "追问单独成题，但同一项目的连续追问归入同一 cluster。",
            "寒暄、反问和流程问题保留，questionType=procedural 且 scored=false。",
            "不得改写原文；promptSegments.text 必须是 originalContent 的原文子串。",
        ].join("\n"),
        userContent: JSON.stringify(input.transcript.turns.map((turn) => ({
            id: turn.id,
            speaker: turn.speaker,
            originalContent: turn.content,
            correctedContent: correctedById.get(turn.id) ?? turn.content,
        }))),
    });

    const originalById = new Map(
        input.transcript.turns.map((turn) => [turn.id, turn]),
    );
    const interviewerIds = input.transcript.turns
        .filter((turn) => turn.speaker === "interviewer")
        .map((turn) => turn.id);

    if (findDuplicates(relation.questions.map((question) => question.id)).length) {
        throw new Error("问题 ID 重复");
    }
    if (findDuplicates(relation.clusters.map((cluster) => cluster.id)).length) {
        throw new Error("问题簇 ID 重复");
    }

    const promptTurnIds = relation.questions.flatMap(
        (question) => question.promptSegments.map((segment) => segment.turnId),
    );
    for (const question of relation.questions) {
        for (const segment of question.promptSegments) {
            const turn = originalById.get(segment.turnId);
            if (turn?.speaker !== "interviewer" || !turn.content.includes(segment.text)) {
                throw new Error(`问题片段无法回到原文: ${segment.turnId}`);
            }
        }
        for (const turnId of question.answerTurnIds) {
            const turn = originalById.get(turnId);
            if (turn?.speaker !== "candidate") {
                throw new Error(`回答引用了非候选人轮次: ${turnId}`);
            }
        }
        if (question.questionType === "procedural" && question.scored) {
            throw new Error(`流程性问题不得评分: ${question.id}`);
        }
    }

    for (const turnId of relation.nonQuestionTurnIds) {
        if (originalById.get(turnId)?.speaker !== "interviewer") {
            throw new Error(`非提问项引用了非面试官轮次: ${turnId}`);
        }
    }
    const overlap = relation.nonQuestionTurnIds.filter(
        (turnId) => promptTurnIds.includes(turnId),
    );
    if (overlap.length) {
        throw new Error(`轮次不能同时标记为问题和非问题: ${overlap.join(",")}`);
    }
    const classifiedIds = new Set([
        ...promptTurnIds,
        ...relation.nonQuestionTurnIds,
    ]);
    const missing = interviewerIds.filter((turnId) => !classifiedIds.has(turnId));
    if (missing.length) {
        throw new Error(`未分类的面试官轮次: ${missing.join(",")}`);
    }

    const clusterById = new Map(
        relation.clusters.map((cluster) => [cluster.id, cluster]),
    );
    for (const question of relation.questions) {
        if (!clusterById.has(question.clusterId)) {
            throw new Error(`问题簇不存在: ${question.clusterId}`);
        }
    }
    for (const cluster of relation.clusters) {
        const expected = relation.questions
            .filter((question) => question.clusterId === cluster.id)
            .map((question) => question.id);
        if (
            findDuplicates(cluster.questionIds).length
            || !sameMembers(cluster.questionIds, expected)
        ) {
            throw new Error(`问题簇关系不一致: ${cluster.id}`);
        }
    }

    const readTurns = (ids: string[]): TranscriptTurn[] => ids.map((turnId) => {
        const turn = originalById.get(turnId);
        if (!turn) throw new Error(`轮次不存在: ${turnId}`);
        return turn;
    });
    const questions = relation.questions.map((question): InterviewQuestion => {
        const promptTurns = readTurns(
            question.promptSegments.map((segment) => segment.turnId),
        );
        const answerTurns = readTurns(question.answerTurnIds);
        const evidenceTurns = [...promptTurns, ...answerTurns];

        return {
            ...question,
            promptTurnIds: [...new Set(
                question.promptSegments.map((segment) => segment.turnId),
            )],
            originalQuestion: question.promptSegments
                .map((segment) => segment.text)
                .join("\n"),
            originalAnswer: answerTurns.map((turn) => turn.content).join("\n"),
            sourceStart: Math.min(...evidenceTurns.map((turn) => turn.sourceStart)),
            sourceEnd: Math.max(...evidenceTurns.map((turn) => turn.sourceEnd)),
        };
    });

    return {
        questions,
        clusters: relation.clusters,
        nonQuestionTurnIds: relation.nonQuestionTurnIds,
    };
}
