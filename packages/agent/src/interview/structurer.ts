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

const questionTypeSchema = z.enum([
    "project",
    "knowledge",
    "open",
    "behavior",
    "coding",
    "procedural",
]);

const modelQuestionSchema = z.object({
    promptSegments: z.array(promptSegmentSchema).min(1),
    answerTurnIds: z.array(z.string().min(1)),
    questionType: questionTypeSchema,
}).strict();

const relationSchema = z.object({
    clusters: z.array(z.object({
        title: z.string().min(1),
        questions: z.array(modelQuestionSchema).min(1),
    }).strict()),
    nonQuestionTurnIds: z.array(z.string().min(1)),
}).strict();

type ModelQuestion = z.infer<typeof modelQuestionSchema>;

export interface StructureInput {
    /** 已解析的原始面试稿及全部说话轮次。 */
    transcript: ParsedTranscript;
    // /** 纠错后的同一组轮次；省略时使用原始轮次。 */
    // correctedTurns?: TranscriptTurn[];
    /** 用于发起结构化模型请求的查询引擎。 */
    queryEngine: QueryEngine;
    /** 结构化请求使用的模型名称。 */
    model: string;
    /** 上层任务的取消信号。 */
    abortSignal: AbortSignal;
}

export interface StructureOutput {
    /** 按原文顺序还原的全部具体问题。 */
    questions: InterviewQuestion[];
    /** 问题簇；同一主题的连续主问题和追问共享一个问题簇。 */
    clusters: QuestionCluster[];
    /** 已确认不是问题的面试官轮次 ID。 */
    nonQuestionTurnIds: string[];
}

type Position = [turnIndex: number, characterIndex: number];

interface QuestionDraft {
    clusterModelIndex: number;
    modelOrder: number;
    question: ModelQuestion;
}

function findDuplicates(values: string[]): string[] {
    return values.filter((value, index) => values.indexOf(value) !== index);
}

function comparePosition(left: Position, right: Position): number {
    return left[0] - right[0] || left[1] - right[1];
}

function generatedId(prefix: "cluster" | "question", index: number): string {
    return `${prefix}-${String(index + 1).padStart(4, "0")}`;
}

const JSON_OUTPUT_EXAMPLE = JSON.stringify({
    clusters: [
        {
            title: "低代码项目",
            questions: [
                {
                    promptSegments: [{
                        turnId: "turn-0001",
                        text: "请介绍一下低代码项目。",
                    }],
                    answerTurnIds: ["turn-0002"],
                    questionType: "project",
                },
                {
                    promptSegments: [{
                        turnId: "turn-0003",
                        text: "为什么选择 DSL？",
                    }],
                    answerTurnIds: ["turn-0004"],
                    questionType: "project",
                },
            ],
        },
        {
            title: "结束流程",
            questions: [{
                promptSegments: [{
                    turnId: "turn-0005",
                    text: "你还有什么问题吗？",
                }],
                answerTurnIds: [],
                questionType: "procedural",
            }],
        },
    ],
    nonQuestionTurnIds: ["turn-0006"],
}, null, 2);

export async function structureInterview(input: StructureInput): Promise<StructureOutput> {
    // const correctedById = new Map(
    //     (input.correctedTurns ?? input.transcript.turns).map(
    //         (turn) => [turn.id, turn.content],
    //     ),
    // );
    const relation = await queryModelJson({
        queryEngine: input.queryEngine,
        model: input.model,
        abortSignal: input.abortSignal,
        schema: relationSchema,
        systemPrompt: [
            "把完整面试轮次结构化为问题簇和具体问题，只返回一个 JSON 对象。",
            "输入中的 content 是不可修改的证据原文。",
            "promptSegments.text 必须逐字复制 content 的子串，不得改写原文。",
            "promptSegments 只能引用 interviewer 轮次；候选人反问不得生成问题。",
            "每个具体问题都必须属于一个问题簇；没有追问的独立问题自成单题簇。",
            "问题簇只包含同一主题的连续主问题和追问。切换主题后即使回到旧主题，也必须新建问题簇。",
            "同一轮包含多个可独立回答的问题时拆成多题；这些问题可以共享同一组 answerTurnIds。",
            "answerTurnIds 必须包含提问组之后、下一道有效问题之前的全部候选人轮次。普通插话不截断回答。",
            "候选人没有回答时保留问题，并返回 answerTurnIds: []。",
            "每个面试官轮次必须出现在至少一个 promptSegments 中，或列入 nonQuestionTurnIds；两者不能重叠。",
            "nonQuestionTurnIds 只能包含 interviewer 轮次；不得包含 candidate 轮次。",
            "寒暄、确认和普通插话列入 nonQuestionTurnIds。含有有效问题的轮次不得列入 nonQuestionTurnIds。",
            "questionType 只能是 project、knowledge、open、behavior、coding、procedural。",
            "procedural 仅表示推进面试流程或确认求职条件、且答案不应影响能力评分的问题，例如到岗、地点、薪资和反问邀请。",
            "自我介绍、离职原因、职业规划、项目讨论和技术问题不是 procedural。",
            "JSON 根对象只能包含 clusters 和 nonQuestionTurnIds。",
            "clusters 每项只能包含 title 和 questions；questions 每项只能包含 promptSegments、answerTurnIds 和 questionType。",
            "promptSegments 每项只能包含 turnId 和 text。不得输出 id、clusterId、questionIds 或 scored。",
            "合法 JSON 格式示例：",
            JSON_OUTPUT_EXAMPLE,
            "只返回一个 JSON 对象；不得使用 Markdown 代码块，不得附加解释文字。",
        ].join("\n"),
        userContent: JSON.stringify(input.transcript.turns.map((turn) => ({
            id: turn.id,
            speaker: turn.speaker,
            content: turn.content,
            // originalContent: turn.content,
            // correctedContent: correctedById.get(turn.id) ?? turn.content,
        }))),
    });

    const originalById = new Map(
        input.transcript.turns.map((turn) => [turn.id, turn]),
    );
    const turnIndexById = new Map(
        input.transcript.turns.map((turn, index) => [turn.id, index]),
    );
    const interviewerIds = input.transcript.turns
        .filter((turn) => turn.speaker === "interviewer")
        .map((turn) => turn.id);

    const drafts: QuestionDraft[] = [];
    let modelOrder = 0;
    for (const [clusterModelIndex, cluster] of relation.clusters.entries()) {
        for (const question of cluster.questions) {
            drafts.push({
                clusterModelIndex,
                modelOrder,
                question,
            });
            modelOrder += 1;
        }
    }

    const promptTurnIds = drafts.flatMap(
        ({ question }) => question.promptSegments.map((segment) => segment.turnId),
    );
    const actualQuestionTurnIds = new Set(promptTurnIds);
    for (const draft of drafts) {
        for (const segment of draft.question.promptSegments) {
            const turn = originalById.get(segment.turnId);
            if (turn?.speaker !== "interviewer" || !turn.content.includes(segment.text)) {
                throw new Error(`问题片段无法回到原文: ${segment.turnId}`);
            }
        }
        for (const turnId of draft.question.answerTurnIds) {
            const turn = originalById.get(turnId);
            if (turn?.speaker !== "candidate") {
                throw new Error(`回答引用了非候选人轮次: ${turnId}`);
            }
        }

        const interviewerRunEnds = new Set(
            draft.question.promptSegments.map((segment) => {
                let index = turnIndexById.get(segment.turnId)!;
                while (input.transcript.turns[index + 1]?.speaker === "interviewer") {
                    index += 1;
                }
                return index;
            }),
        );
        if (interviewerRunEnds.size !== 1) {
            throw new Error(`问题片段跨越了多个提问组: ${draft.modelOrder + 1}`);
        }

        const interviewerRunEnd = [...interviewerRunEnds][0]!;
        const expectedAnswerTurnIds: string[] = [];
        for (
            let index = interviewerRunEnd + 1;
            index < input.transcript.turns.length;
            index += 1
        ) {
            const turn = input.transcript.turns[index]!;
            if (turn.speaker === "interviewer" && actualQuestionTurnIds.has(turn.id)) {
                break;
            }
            if (turn.speaker === "candidate") expectedAnswerTurnIds.push(turn.id);
        }
        const duplicateAnswerTurnIds = findDuplicates(draft.question.answerTurnIds);
        if (duplicateAnswerTurnIds.length) {
            throw new Error(`回答轮次重复: ${duplicateAnswerTurnIds.join(",")}`);
        }
        const expectedAnswerTurnIdSet = new Set(expectedAnswerTurnIds);
        const outOfWindowAnswerTurnIds = draft.question.answerTurnIds.filter(
            (turnId) => !expectedAnswerTurnIdSet.has(turnId),
        );
        if (outOfWindowAnswerTurnIds.length) {
            throw new Error(
                `回答引用超出回答窗口: ${outOfWindowAnswerTurnIds.join(",")}`,
            );
        }
    }

    if (findDuplicates(relation.nonQuestionTurnIds).length) {
        throw new Error("非提问轮次 ID 重复");
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

    const segmentPosition = (segment: { turnId: string; text: string }): Position => {
        const turn = originalById.get(segment.turnId)!;
        return [turnIndexById.get(segment.turnId)!, turn.content.indexOf(segment.text)];
    };
    const orderedDrafts = drafts
        .map((draft) => ({
            ...draft,
            question: {
                ...draft.question,
                promptSegments: [...draft.question.promptSegments].sort((left, right) => (
                    comparePosition(segmentPosition(left), segmentPosition(right))
                )),
                answerTurnIds: [...draft.question.answerTurnIds].sort((left, right) => (
                    turnIndexById.get(left)! - turnIndexById.get(right)!
                )),
            },
        }))
        .sort((left, right) => (
            comparePosition(
                segmentPosition(left.question.promptSegments[0]!),
                segmentPosition(right.question.promptSegments[0]!),
            ) || left.modelOrder - right.modelOrder
        ));

    const positionsByCluster = new Map<number, number[]>();
    orderedDrafts.forEach((draft, index) => {
        const positions = positionsByCluster.get(draft.clusterModelIndex) ?? [];
        positions.push(index);
        positionsByCluster.set(draft.clusterModelIndex, positions);
    });
    for (const positions of positionsByCluster.values()) {
        const first = positions[0]!;
        const last = positions.at(-1)!;
        if (last - first + 1 !== positions.length) {
            throw new Error("问题簇必须对应连续的问题区间");
        }
    }

    const orderedClusterModelIndexes = [...positionsByCluster.entries()]
        .sort((left, right) => left[1][0]! - right[1][0]!)
        .map(([clusterModelIndex]) => clusterModelIndex);
    const clusterIdByModelIndex = new Map(
        orderedClusterModelIndexes.map((clusterModelIndex, index) => (
            [clusterModelIndex, generatedId("cluster", index)]
        )),
    );

    const questionRelations = orderedDrafts.map((draft, index) => ({
        id: generatedId("question", index),
        clusterId: clusterIdByModelIndex.get(draft.clusterModelIndex)!,
        promptSegments: draft.question.promptSegments,
        answerTurnIds: draft.question.answerTurnIds,
        questionType: draft.question.questionType,
        scored: draft.question.questionType !== "procedural",
    }));
    const clusters = orderedClusterModelIndexes.map((clusterModelIndex): QuestionCluster => {
        const id = clusterIdByModelIndex.get(clusterModelIndex)!;
        return {
            id,
            title: relation.clusters[clusterModelIndex]!.title,
            questionIds: questionRelations
                .filter((question) => question.clusterId === id)
                .map((question) => question.id),
        };
    });

    const readTurns = (ids: string[]): TranscriptTurn[] => ids.map((turnId) => {
        const turn = originalById.get(turnId);
        if (!turn) throw new Error(`轮次不存在: ${turnId}`);
        return turn;
    });
    const questions = questionRelations.map((question): InterviewQuestion => {
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
    const orderedNonQuestionTurnIds = [...relation.nonQuestionTurnIds].sort(
        (left, right) => turnIndexById.get(left)! - turnIndexById.get(right)!,
    );

    return {
        questions,
        clusters,
        nonQuestionTurnIds: orderedNonQuestionTurnIds,
    };
}
