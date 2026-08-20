import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";
import { structureInterview } from "../../src/interview/structurer.js";
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

function validRelation(): Record<string, unknown> {
    return {
        clusters: [
            {
                id: "cluster-1",
                title: "低代码项目",
                questionIds: ["q-1", "q-2", "q-3"],
            },
            {
                id: "cluster-2",
                title: "候选人反问",
                questionIds: ["q-4"],
            },
        ],
        questions: [
            {
                id: "q-1",
                clusterId: "cluster-1",
                promptSegments: [{
                    turnId: "turn-0001",
                    text: "先介绍低代码项目。",
                }],
                answerTurnIds: ["turn-0002"],
                questionType: "project",
                scored: true,
            },
            {
                id: "q-2",
                clusterId: "cluster-1",
                promptSegments: [{
                    turnId: "turn-0001",
                    text: "你负责什么？",
                }],
                answerTurnIds: ["turn-0002"],
                questionType: "project",
                scored: true,
            },
            {
                id: "q-3",
                clusterId: "cluster-1",
                promptSegments: [{
                    turnId: "turn-0003",
                    text: "这里最难的问题是什么？",
                }],
                answerTurnIds: ["turn-0004"],
                questionType: "project",
                scored: true,
            },
            {
                id: "q-4",
                clusterId: "cluster-2",
                promptSegments: [{
                    turnId: "turn-0006",
                    text: "你还有什么想问的吗？",
                }],
                answerTurnIds: ["turn-0007"],
                questionType: "procedural",
                scored: false,
            },
        ],
        nonQuestionTurnIds: ["turn-0005"],
    };
}

async function runWith(relation: Record<string, unknown>) {
    const transcript = parseTranscript(source);
    return structureInterview({
        transcript,
        queryEngine: new QueryEngine(
            new FakeTextProvider(JSON.stringify(relation)),
        ),
        model: "fake-model",
        abortSignal: new AbortController().signal,
    });
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

function interruptedAnswerRelation(answerTurnIds: string[]): Record<string, unknown> {
    return {
        clusters: [{
            id: "cluster-project",
            title: "项目",
            questionIds: ["q-project", "q-follow-up"],
        }],
        questions: [
            {
                id: "q-project",
                clusterId: "cluster-project",
                promptSegments: [{ turnId: "turn-0001", text: "请介绍这个项目。" }],
                answerTurnIds,
                questionType: "project",
                scored: true,
            },
            {
                id: "q-follow-up",
                clusterId: "cluster-project",
                promptSegments: [{ turnId: "turn-0005", text: "为什么这样设计？" }],
                answerTurnIds: ["turn-0006"],
                questionType: "project",
                scored: true,
            },
        ],
        nonQuestionTurnIds: ["turn-0003"],
    };
}

async function runInterrupted(answerTurnIds: string[]) {
    const transcript = parseTranscript(interruptedAnswerSource);
    return structureInterview({
        transcript,
        queryEngine: new QueryEngine(
            new FakeTextProvider(JSON.stringify(interruptedAnswerRelation(answerTurnIds))),
        ),
        model: "fake-model",
        abortSignal: new AbortController().signal,
    });
}

test("同一轮的多个问题单独成题，连续项目追问归入同一簇", async () => {
    const result = await runWith(validRelation());

    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.clusters[0]?.questionIds, ["q-1", "q-2", "q-3"]);
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
    const questions = relation.questions as Array<{
        promptSegments: Array<{ turnId: string; text: string }>;
    }>;
    questions[0]!.promptSegments[0]!.text = "模型改写后的问题";

    await assert.rejects(() => runWith(relation), /问题片段无法回到原文/);
});

test("回答只能引用候选人轮次", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{ answerTurnIds: string[] }>;
    questions[0]!.answerTurnIds = ["turn-0003"];

    await assert.rejects(() => runWith(relation), /回答引用了非候选人轮次/);
});

test("回答只能绑定提问组后紧邻的候选人回答块", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{ answerTurnIds: string[] }>;
    questions[0]!.answerTurnIds = ["turn-0004"];

    await assert.rejects(
        () => runWith(relation),
        /回答轮次必须完整覆盖回答窗口/,
    );
});

test("回答轮次不能为空", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{ answerTurnIds: string[] }>;
    questions[0]!.answerTurnIds = [];

    await assert.rejects(
        () => runWith(relation),
        /回答轮次必须完整覆盖回答窗口/,
    );
});

test("回答轮次不能遗漏窗口内的候选人继续回答", async () => {
    await assert.rejects(
        () => runInterrupted(["turn-0002"]),
        /回答轮次必须完整覆盖回答窗口/,
    );
});

test("非问题插话不会截断候选人的完整回答窗口", async () => {
    const result = await runInterrupted(["turn-0002", "turn-0004"]);

    assert.deepEqual(
        result.questions[0]?.answerTurnIds,
        ["turn-0002", "turn-0004"],
    );
    assert.equal(
        result.questions[0]?.originalAnswer,
        "我先说明项目背景。\n然后补充项目结果。",
    );
});

test("实际问题没有候选人回答时明确拒绝", async () => {
    const transcript = parseTranscript("面试官\n请介绍项目。");
    const relation = {
        clusters: [{ id: "cluster-1", title: "项目", questionIds: ["q-1"] }],
        questions: [{
            id: "q-1",
            clusterId: "cluster-1",
            promptSegments: [{ turnId: "turn-0001", text: "请介绍项目。" }],
            answerTurnIds: [],
            questionType: "project",
            scored: true,
        }],
        nonQuestionTurnIds: [],
    };

    await assert.rejects(
        () => structureInterview({
            transcript,
            queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify(relation))),
            model: "fake-model",
            abortSignal: new AbortController().signal,
        }),
        /实际问题没有候选人回答/,
    );
});

test("连续多个面试官提问共享其后紧邻的候选人回答块", async () => {
    const consecutiveSource = [
        "面试官 01:00",
        "先介绍项目。",
        "面试官 01:01",
        "你负责什么？",
        "候选人 01:02",
        "我负责 DSL 渲染链路。",
    ].join("\n");
    const transcript = parseTranscript(consecutiveSource);
    const relation = {
        clusters: [{
            id: "cluster-1",
            title: "项目",
            questionIds: ["q-1", "q-2"],
        }],
        questions: [
            {
                id: "q-1",
                clusterId: "cluster-1",
                promptSegments: [{ turnId: "turn-0001", text: "先介绍项目。" }],
                answerTurnIds: ["turn-0003"],
                questionType: "project",
                scored: true,
            },
            {
                id: "q-2",
                clusterId: "cluster-1",
                promptSegments: [{ turnId: "turn-0002", text: "你负责什么？" }],
                answerTurnIds: ["turn-0003"],
                questionType: "project",
                scored: true,
            },
        ],
        nonQuestionTurnIds: [],
    };

    const result = await structureInterview({
        transcript,
        queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify(relation))),
        model: "fake-model",
        abortSignal: new AbortController().signal,
    });

    assert.deepEqual(
        result.questions.map((question) => question.answerTurnIds),
        [["turn-0003"], ["turn-0003"]],
    );
});

test("按原文位置规范化问题、追问和问题簇顺序", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{ id: string }>;
    relation.questions = [questions[2]!, questions[1]!, questions[0]!, questions[3]!];
    const clusters = relation.clusters as Array<{ id: string; questionIds: string[] }>;
    clusters[0]!.questionIds = ["q-3", "q-2", "q-1"];
    relation.clusters = [clusters[1]!, clusters[0]!];

    const result = await runWith(relation);

    assert.deepEqual(
        result.questions.map((question) => question.id),
        ["q-1", "q-2", "q-3", "q-4"],
    );
    assert.deepEqual(
        result.clusters.map((item) => item.id),
        ["cluster-1", "cluster-2"],
    );
    assert.deepEqual(result.clusters[0]?.questionIds, ["q-1", "q-2", "q-3"]);
});

test("问题与问题簇的双向关系必须一致", async () => {
    const relation = validRelation();
    const clusters = relation.clusters as Array<{ questionIds: string[] }>;
    clusters[0]!.questionIds = ["q-1", "q-3"];

    await assert.rejects(() => runWith(relation), /问题簇关系不一致/);
});

test("非提问轮次不能同时承载具体问题", async () => {
    const relation = validRelation();
    relation.nonQuestionTurnIds = ["turn-0001", "turn-0005"];

    await assert.rejects(() => runWith(relation), /轮次不能同时标记为问题和非问题/);
});

test("流程性问题不得参与评分", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{
        questionType: string;
        scored: boolean;
    }>;
    questions[3]!.scored = true;

    await assert.rejects(() => runWith(relation), /流程性问题不得评分/);
});

test("非流程题不得由模型下调为不评分", async () => {
    const relation = validRelation();
    const questions = relation.questions as Array<{
        questionType: string;
        scored: boolean;
    }>;
    questions[0]!.scored = false;

    await assert.rejects(() => runWith(relation), /非流程题必须评分/);
});
