import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";
import type { InterviewQuestion, QuestionCluster } from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createExtractProjectFactsTool } from "../../src/tools/tool-item/extract-project-facts.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const transcript = parseTranscript([
    "面试官 01:00",
    "低代码项目里你负责什么？首屏指标提升多少？",
    "候选人 01:10",
    "我负责 DSL 渲染链路。",
    "面试官 02:00",
    "另一个项目你负责全部架构吗？",
    "候选人 02:10",
    "我只参与了一个模块。",
].join("\n"));

const cluster: QuestionCluster = {
    id: "project-a",
    title: "低代码项目",
    questionIds: ["q-1", "q-2"],
};

const questions: InterviewQuestion[] = [
    {
        id: "q-1",
        clusterId: "project-a",
        promptTurnIds: ["turn-0001"],
        promptSegments: [{ turnId: "turn-0001", text: "低代码项目里你负责什么？" }],
        answerTurnIds: ["turn-0002"],
        originalQuestion: "低代码项目里你负责什么？",
        originalAnswer: "我负责 DSL 渲染链路。",
        questionType: "project",
        scored: true,
        sourceStart: transcript.turns[0]!.sourceStart,
        sourceEnd: transcript.turns[1]!.sourceEnd,
    },
    {
        id: "q-2",
        clusterId: "project-a",
        promptTurnIds: ["turn-0001"],
        promptSegments: [{ turnId: "turn-0001", text: "首屏指标提升多少？" }],
        answerTurnIds: ["turn-0002"],
        originalQuestion: "首屏指标提升多少？",
        originalAnswer: "我负责 DSL 渲染链路。",
        questionType: "project",
        scored: true,
        sourceStart: transcript.turns[0]!.sourceStart,
        sourceEnd: transcript.turns[1]!.sourceEnd,
    },
    {
        id: "q-outside",
        clusterId: "project-b",
        promptTurnIds: ["turn-0003"],
        promptSegments: [{ turnId: "turn-0003", text: "另一个项目你负责全部架构吗？" }],
        answerTurnIds: ["turn-0004"],
        originalQuestion: "另一个项目你负责全部架构吗？",
        originalAnswer: "我只参与了一个模块。",
        questionType: "project",
        scored: true,
        sourceStart: transcript.turns[2]!.sourceStart,
        sourceEnd: transcript.turns[3]!.sourceEnd,
    },
];

function context(response: string): ToolContext {
    return {
        queryEngine: new QueryEngine(new FakeTextProvider(response)),
        abortSignal: new AbortController().signal,
    };
}

test("只接受当前项目簇内且能回到候选人原文的事实", async () => {
    const response = JSON.stringify({ facts: [
        {
            key: "project-a.role",
            category: "responsibility",
            value: "负责 DSL 渲染链路",
            status: "stated",
            evidenceTurnIds: ["turn-0002"],
            affectedQuestionIds: ["q-1"],
            clarificationQuestion: null,
            impact: "high",
        },
        {
            key: "project-a.metric",
            category: "metric",
            value: null,
            status: "unknown",
            evidenceTurnIds: [],
            affectedQuestionIds: ["q-2"],
            clarificationQuestion: "首屏指标具体提升多少？",
            impact: "high",
        },
    ] });

    const result = await createExtractProjectFactsTool("fake-model").execute(
        { transcript, cluster, questions },
        context(response),
    );

    assert.equal(result.success, true);
    assert.equal(result.data?.facts[0]?.status, "stated");
    assert.deepEqual(result.data?.clarificationCandidates, [{
        factKey: "project-a.metric",
        question: "首屏指标具体提升多少？",
        affectedQuestionIds: ["q-2"],
        impact: "high",
    }]);
});

test("拒绝引用其他问题簇或面试官轮次的事实", async () => {
    const response = JSON.stringify({ facts: [{
        key: "project-a.role",
        category: "responsibility",
        value: "负责全部架构",
        status: "stated",
        evidenceTurnIds: ["turn-0001"],
        affectedQuestionIds: ["q-outside"],
        clarificationQuestion: null,
        impact: "high",
    }] });

    const result = await createExtractProjectFactsTool("fake-model").execute(
        { transcript, cluster, questions },
        context(response),
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "service_error");
});
