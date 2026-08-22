import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";
import { structureInterview } from "../../src/interview/structurer.js";
import type { ParsedTranscript } from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { FakeTextProvider } from "./fake-provider.js";

const source = [
    "面试官 01:00",
    "先介绍低代码项目。你负责什么？",
    "候选人 01:10",
    "我负责 DSL 渲染链路。",
    "面试官 01:30",
    "这里最难的问题是什么？",
    "候选人 01:35",
    "嗯，是历史协议兼容。",
    "面试官 01:50",
    "好的，我们继续。",
    "面试官 02:00",
    "你还有什么想问的吗？",
    "候选人 02:05",
    "团队规模多大？",
].join("\n");

type ModelQuestion = {
    promptSegments: Array<{ turnId: string; text: string }>;
    answerTurnIds: string[];
    questionType: "project" | "knowledge" | "open" | "behavior" | "coding" | "procedural";
};

type ModelCluster = { title: string; questions: ModelQuestion[] };
type ModelRelation = { clusters: ModelCluster[]; nonQuestionTurnIds: string[] };

function validRelation(): ModelRelation {
    return {
        clusters: [
            {
                title: "低代码项目",
                questions: [
                    {
                        promptSegments: [{ turnId: "turn-0001", text: "先介绍低代码项目。" }],
                        answerTurnIds: ["turn-0002"],
                        questionType: "project",
                    },
                    {
                        promptSegments: [{ turnId: "turn-0001", text: "你负责什么？" }],
                        answerTurnIds: ["turn-0002"],
                        questionType: "project",
                    },
                    {
                        promptSegments: [{ turnId: "turn-0003", text: "这里最难的问题是什么？" }],
                        answerTurnIds: ["turn-0004"],
                        questionType: "project",
                    },
                ],
            },
            {
                title: "候选人反问",
                questions: [{
                    promptSegments: [{ turnId: "turn-0006", text: "你还有什么想问的吗？" }],
                    answerTurnIds: ["turn-0007"],
                    questionType: "procedural",
                }],
            },
        ],
        nonQuestionTurnIds: ["turn-0005"],
    };
}

async function runWith(
    relation: ModelRelation,
    input?: { transcript?: ParsedTranscript /* correctedTurns?: TranscriptTurn[] */ },
) {
    const transcript = input?.transcript ?? parseTranscript(source);
    const provider = new FakeTextProvider(JSON.stringify(relation));
    const result = await structureInterview({
        transcript,
        // ...(input?.correctedTurns ? { correctedTurns: input.correctedTurns } : {}),
        queryEngine: new QueryEngine(provider),
        model: "fake-model",
        abortSignal: new AbortController().signal,
    });
    return { result, provider };
}

const interruptedAnswerSource = [
    "面试官 01:00",
    "请介绍这个项目。",
    "候选人 01:01",
    "我先说明项目背景。",
    "面试官 01:02",
    "对。",
    "候选人 01:03",
    "然后补充项目结果。",
    "面试官 01:04",
    "为什么这样设计？",
    "候选人 01:05",
    "因为要兼容旧协议。",
].join("\n");

function interruptedAnswerRelation(answerTurnIds: string[]): ModelRelation {
    return {
        clusters: [{
            title: "项目",
            questions: [
                {
                    promptSegments: [{ turnId: "turn-0001", text: "请介绍这个项目。" }],
                    answerTurnIds,
                    questionType: "project",
                },
                {
                    promptSegments: [{ turnId: "turn-0005", text: "为什么这样设计？" }],
                    answerTurnIds: ["turn-0006"],
                    questionType: "project",
                },
            ],
        }],
        nonQuestionTurnIds: ["turn-0003"],
    };
}

async function runInterrupted(answerTurnIds: string[]) {
    const transcript = parseTranscript(interruptedAnswerSource);
    return (await runWith(interruptedAnswerRelation(answerTurnIds), { transcript })).result;
}

test("嵌套模型结果生成下游需要的扁平问题和问题簇", async () => {
    const { result } = await runWith(validRelation());

    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.clusters[0]?.questionIds, [
        "question-0001",
        "question-0002",
        "question-0003",
    ]);
    assert.equal(result.questions[0]?.clusterId, "cluster-0001");
    assert.equal(result.questions[0]?.originalQuestion, "先介绍低代码项目。");
    assert.equal(result.questions[1]?.originalQuestion, "你负责什么？");
    assert.equal(result.questions[2]?.originalAnswer, "嗯，是历史协议兼容。");
    assert.deepEqual(result.questions[0]?.promptTurnIds, ["turn-0001"]);
    assert.deepEqual(result.nonQuestionTurnIds, ["turn-0005"]);
    assert.equal(result.questions[3]?.scored, false);
});

test("模型漏掉面试官轮次时拒绝结果", async () => {
    const relation = validRelation();
    relation.nonQuestionTurnIds = [];
    await assert.rejects(() => runWith(relation), /未分类的面试官轮次: turn-0005/);
});

test("问题片段必须是对应面试官轮次中的原文", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.promptSegments[0]!.text = "模型改写后的问题";
    await assert.rejects(() => runWith(relation), /问题片段无法回到原文/);
});

test("回答只能引用候选人轮次", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = ["turn-0003"];
    await assert.rejects(() => runWith(relation), /回答引用了非候选人轮次/);
});

test("回答不能引用回答窗口之外的候选人轮次", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = ["turn-0004"];
    await assert.rejects(() => runWith(relation), /回答引用超出回答窗口/);
});

test("非空回答窗口允许返回空回答轮次", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = [];
    const { result } = await runWith(relation);
    assert.deepEqual(result.questions[0]?.answerTurnIds, []);
});

test("回答窗口允许只绑定部分候选人轮次", async () => {
    const result = await runInterrupted(["turn-0002"]);
    assert.deepEqual(result.questions[0]?.answerTurnIds, ["turn-0002"]);
});

test("回答轮次不能重复", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0]!.answerTurnIds = ["turn-0002", "turn-0002"];
    await assert.rejects(() => runWith(relation), /回答轮次重复/);
});

test("非问题插话不会截断候选人的完整回答窗口", async () => {
    const result = await runInterrupted(["turn-0002", "turn-0004"]);
    assert.deepEqual(result.questions[0]?.answerTurnIds, ["turn-0002", "turn-0004"]);
    assert.equal(result.questions[0]?.originalAnswer, "我先说明项目背景。\n然后补充项目结果。");
});

test("实际问题没有候选人回答时保留空回答", async () => {
    const transcript = parseTranscript("面试官\n请介绍项目。");
    const relation: ModelRelation = {
        clusters: [{
            title: "项目",
            questions: [{
                promptSegments: [{ turnId: "turn-0001", text: "请介绍项目。" }],
                answerTurnIds: [],
                questionType: "project",
            }],
        }],
        nonQuestionTurnIds: [],
    };
    const { result } = await runWith(relation, { transcript });
    assert.deepEqual(result.questions[0]?.answerTurnIds, []);
    assert.equal(result.questions[0]?.originalAnswer, "");
});

test("连续多个面试官提问共享其后紧邻的候选人回答块", async () => {
    const transcript = parseTranscript([
        "面试官 01:00", "先介绍项目。", "面试官 01:01", "你负责什么？",
        "候选人 01:02", "我负责 DSL 渲染链路。",
    ].join("\n"));
    const relation: ModelRelation = {
        clusters: [{
            title: "项目",
            questions: [
                {
                    promptSegments: [{ turnId: "turn-0001", text: "先介绍项目。" }],
                    answerTurnIds: ["turn-0003"],
                    questionType: "project",
                },
                {
                    promptSegments: [{ turnId: "turn-0002", text: "你负责什么？" }],
                    answerTurnIds: ["turn-0003"],
                    questionType: "project",
                },
            ],
        }],
        nonQuestionTurnIds: [],
    };
    const { result } = await runWith(relation, { transcript });
    assert.deepEqual(result.questions.map((question) => question.answerTurnIds), [
        ["turn-0003"],
        ["turn-0003"],
    ]);
});

test("同一问题的提示片段跨提问组时使用最后一组确定回答窗口", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions[0] = {
        promptSegments: [
            { turnId: "turn-0001", text: "先介绍低代码项目。" },
            { turnId: "turn-0003", text: "这里最难的问题是什么？" },
        ],
        answerTurnIds: ["turn-0004"],
        questionType: "project",
    };
    relation.clusters[0]!.questions.splice(2, 1);

    const { result } = await runWith(relation);

    assert.deepEqual(result.questions[0]?.promptTurnIds, ["turn-0001", "turn-0003"]);
    assert.deepEqual(result.questions[0]?.answerTurnIds, ["turn-0004"]);
});

test("按原文位置规范化问题和问题簇顺序后生成稳定 ID", async () => {
    const relation = validRelation();
    relation.clusters[0]!.questions.reverse();
    relation.clusters.reverse();
    const { result } = await runWith(relation);
    assert.deepEqual(result.questions.map((question) => question.id), [
        "question-0001", "question-0002", "question-0003", "question-0004",
    ]);
    assert.deepEqual(result.clusters.map((item) => item.id), ["cluster-0001", "cluster-0002"]);
    assert.deepEqual(result.clusters[0]?.questionIds, [
        "question-0001", "question-0002", "question-0003",
    ]);
});

test("同一问题簇不能跨越其他问题簇后继续", async () => {
    const relation = validRelation();
    const projectCluster = relation.clusters[0]!;
    const proceduralCluster = relation.clusters[1]!;
    const middleQuestion = projectCluster.questions.pop()!;
    projectCluster.questions.push(...proceduralCluster.questions);
    relation.clusters = [projectCluster, {
        title: "中间主题",
        questions: [middleQuestion],
    }];
    await assert.rejects(() => runWith(relation), /问题簇必须对应连续的问题区间/);
});

test("切换主题后回到旧主题时生成三个连续问题簇", async () => {
    const transcript = parseTranscript([
        "面试官", "介绍项目 A。", "候选人", "回答 A。",
        "面试官", "介绍项目 B。", "候选人", "回答 B。",
        "面试官", "回到项目 A，还有什么补充？", "候选人", "补充 A。",
    ].join("\n"));
    const relation: ModelRelation = {
        clusters: [
            {
                title: "项目 A",
                questions: [{
                    promptSegments: [{ turnId: "turn-0001", text: "介绍项目 A。" }],
                    answerTurnIds: ["turn-0002"],
                    questionType: "project",
                }],
            },
            {
                title: "项目 B",
                questions: [{
                    promptSegments: [{ turnId: "turn-0003", text: "介绍项目 B。" }],
                    answerTurnIds: ["turn-0004"],
                    questionType: "project",
                }],
            },
            {
                title: "项目 A",
                questions: [{
                    promptSegments: [{
                        turnId: "turn-0005",
                        text: "回到项目 A，还有什么补充？",
                    }],
                    answerTurnIds: ["turn-0006"],
                    questionType: "project",
                }],
            },
        ],
        nonQuestionTurnIds: [],
    };

    const { result } = await runWith(relation, { transcript });

    assert.deepEqual(result.clusters.map((cluster) => cluster.title), [
        "项目 A",
        "项目 B",
        "项目 A",
    ]);
    assert.deepEqual(result.clusters.map((cluster) => cluster.questionIds.length), [1, 1, 1]);
});

test("模型不得返回由程序生成的派生字段", async () => {
    const relation = {
        ...validRelation(),
        questions: [],
    } as ModelRelation;

    await assert.rejects(() => runWith(relation), /unrecognized_keys/);
});

test("非提问轮次不能同时承载具体问题", async () => {
    const relation = validRelation();
    relation.nonQuestionTurnIds = ["turn-0001", "turn-0005"];
    await assert.rejects(() => runWith(relation), /轮次不能同时标记为问题和非问题/);
});

test("程序根据问题类型生成 scored", async () => {
    const { result } = await runWith(validRelation());
    assert.deepEqual(result.questions.map((question) => question.scored), [true, true, true, false]);
});

test("系统 Prompt 说明 JSON 格式且模型看到不可修改的原文", async () => {
    const transcript = parseTranscript([
        "面试官", "请介绍 reat 项目。", "候选人", "这是一个前端项目。",
    ].join("\n"));
    // const correctedTurns = transcript.turns.map((turn) => ({
    //     ...turn,
    //     content: turn.content.replace("reat", "React"),
    // }));
    const relation: ModelRelation = {
        clusters: [{
            title: "React 项目",
            questions: [{
                promptSegments: [{ turnId: "turn-0001", text: "请介绍 reat 项目。" }],
                answerTurnIds: ["turn-0002"],
                questionType: "project",
            }],
        }],
        nonQuestionTurnIds: [],
    };
    const { provider } = await runWith(relation, { transcript /* correctedTurns */ });
    const systemPrompt = provider.request?.systemPrompt ?? "";
    assert.match(systemPrompt, /"clusters"/);
    assert.match(systemPrompt, /"questions"/);
    assert.match(systemPrompt, /"nonQuestionTurnIds"/);
    assert.match(systemPrompt, /只返回一个 JSON 对象/);
    assert.match(systemPrompt, /promptSegments 只能引用 interviewer 轮次/);
    assert.match(systemPrompt, /候选人反问不得生成问题/);
    assert.match(systemPrompt, /nonQuestionTurnIds 只能包含 interviewer 轮次/);
    const turns = JSON.parse(provider.request?.messages[0]?.content ?? "[]") as Array<unknown>;
    assert.deepEqual(turns[0], {
        id: "turn-0001",
        speaker: "interviewer",
        content: "请介绍 reat 项目。",
        // originalContent: "请介绍 reat 项目。",
        // correctedContent: "请介绍 React 项目。",
    });
});
