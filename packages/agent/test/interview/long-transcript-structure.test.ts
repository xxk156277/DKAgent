import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";
import { structureInterview } from "../../src/interview/structurer.js";
import type {
    InterviewQuestionType,
    ParsedTranscript,
} from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { FakeTextProvider } from "./fake-provider.js";

function questionType(content: string): InterviewQuestionType {
    if (content.includes("想问")) return "procedural";
    if (/项目甲|DSL|协议|缓存|首屏|指标/.test(content)) return "project";
    if (/项目乙|监控|灰度|回滚|协作/.test(content)) return "project";
    if (/冲突|推动|复盘|失败/.test(content)) return "behavior";
    if (/实现|代码|算法/.test(content)) return "coding";
    if (/如果|取舍|设计/.test(content)) return "open";
    return "knowledge";
}

function clusterId(content: string, index: number): string {
    if (/项目甲|DSL|协议|缓存|首屏|指标/.test(content)) return "project-a";
    if (/项目乙|监控|灰度|回滚|协作/.test(content)) return "project-b";
    if (content.includes("想问")) return "procedural";
    return `topic-${index + 1}`;
}

function promptTexts(content: string): string[] {
    if (content === "先介绍一下项目甲。你在其中负责什么？") {
        return ["先介绍一下项目甲。", "你在其中负责什么？"];
    }
    return [content];
}

function buildFixtureRelation(transcript: ParsedTranscript): string {
    const questions: Array<Record<string, unknown> & { clusterKey: string }> = [];
    let activeClusterBase = "";
    let activeClusterKey = "";
    let clusterRun = 0;
    const nonQuestionTurnIds = transcript.turns
        .filter((turn) => (
            turn.speaker === "interviewer"
            && turn.content === "好的，我们继续。"
        ))
        .map((turn) => turn.id);
    const actualQuestionTurnIds = new Set(
        transcript.turns
            .filter((turn) => (
                turn.speaker === "interviewer"
                && !nonQuestionTurnIds.includes(turn.id)
            ))
            .map((turn) => turn.id),
    );

    for (const [turnIndex, turn] of transcript.turns.entries()) {
        if (turn.speaker !== "interviewer") continue;
        if (turn.content === "好的，我们继续。") {
            continue;
        }

        let interviewerRunEnd = turnIndex;
        while (transcript.turns[interviewerRunEnd + 1]?.speaker === "interviewer") {
            interviewerRunEnd += 1;
        }
        const answerTurnIds: string[] = [];
        for (
            let index = interviewerRunEnd + 1;
            index < transcript.turns.length;
            index += 1
        ) {
            const next = transcript.turns[index]!;
            if (
                next.speaker === "interviewer"
                && actualQuestionTurnIds.has(next.id)
            ) break;
            if (next.speaker === "candidate") answerTurnIds.push(next.id);
        }
        const type = questionType(turn.content);
        const clusterBase = clusterId(turn.content, questions.length);
        if (clusterBase !== activeClusterBase) {
            activeClusterBase = clusterBase;
            clusterRun += 1;
            activeClusterKey = `${clusterBase}-run-${clusterRun}`;
        }
        for (const text of promptTexts(turn.content)) {
            questions.push({
                clusterKey: activeClusterKey,
                promptSegments: [{ turnId: turn.id, text }],
                answerTurnIds,
                questionType: type,
            });
        }
    }

    const ids = [...new Set(questions.map((question) => question.clusterKey))];
    return JSON.stringify({
        nonQuestionTurnIds,
        clusters: ids.map((id) => ({
            title: id,
            questions: questions
                .filter((question) => question.clusterKey === id)
                .map(({ clusterKey: _clusterKey, ...question }) => question),
        })),
    });
}

test("长项目面试稿不会丢题、改写原文或删除口头表达", async () => {
    const source = await readFile(
        resolve("packages/agent/test/fixtures/long-project-interview.md"),
        "utf8",
    );
    const transcript = parseTranscript(source);
    assert.ok(transcript.turns.length >= 80);
    const mistakenTurn = transcript.turns.find((turn) => turn.content.includes("reat"));
    assert.ok(mistakenTurn);

    const structured = await structureInterview({
        transcript,
        queryEngine: new QueryEngine(
            new FakeTextProvider(buildFixtureRelation(transcript)),
        ),
        model: "fake-model",
        abortSignal: new AbortController().signal,
    });

    const interviewerCount = transcript.turns.filter(
        (turn) => turn.speaker === "interviewer",
    ).length;
    const classifiedTurnIds = new Set([
        ...structured.questions.flatMap((question) => question.promptTurnIds),
        ...structured.nonQuestionTurnIds,
    ]);
    assert.equal(classifiedTurnIds.size, interviewerCount);
    assert.ok(structured.questions.length > interviewerCount - 1);
    assert.equal(transcript.source, source);
    assert.match(
        transcript.turns.map((turn) => turn.content).join("\n"),
        /嗯|呃|然后然后/,
    );
    assert.match(mistakenTurn.content, /reat/);
    assert.ok(structured.clusters.some((cluster) => cluster.questionIds.length >= 4));
    assert.ok(structured.questions.some((question) => !question.scored));

    for (const question of structured.questions) {
        const evidence = source.slice(question.sourceStart, question.sourceEnd);
        for (const segment of question.promptSegments) {
            assert.ok(evidence.includes(segment.text));
        }
    }

    const collaboration = structured.questions.find(
        (question) => question.originalQuestion === "你如何推动上线？",
    );
    assert.deepEqual(collaboration?.answerTurnIds.length, 2);
});
