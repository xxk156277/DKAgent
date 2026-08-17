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
        correctedTurns: transcript.turns,
        queryEngine: new QueryEngine(
            new FakeTextProvider(JSON.stringify(relation)),
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
