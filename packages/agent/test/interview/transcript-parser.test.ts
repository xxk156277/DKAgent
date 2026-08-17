import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";

test("解析多种角色标题和时间格式，并保留原文位置", () => {
    const source = [
        "面试官 00:01:02",
        "介绍一下你的低代码项目。",
        "求职者 00:01:08",
        "嗯，我主要负责 DSL 接入。",
        "面试官",
        "具体难点是什么？",
    ].join("\n");

    const result = parseTranscript(source);

    assert.equal(result.source, source);
    assert.deepEqual(result.turns.map((turn) => turn.speaker), [
        "interviewer",
        "candidate",
        "interviewer",
    ]);
    assert.deepEqual(result.turns.map((turn) => turn.timestamp), [
        "00:01:02",
        "00:01:08",
        undefined,
    ]);
    assert.equal(result.turns[1]?.content, "嗯，我主要负责 DSL 接入。");
    assert.equal(
        source.slice(result.turns[1]!.sourceStart, result.turns[1]!.sourceEnd),
        "求职者 00:01:08\n嗯，我主要负责 DSL 接入。",
    );
});

test("连续同角色发言不丢失，也不合并原文证据", () => {
    const source = [
        "发言人 1 10:01",
        "项目规模多大？",
        "发言人 1 10:03",
        "你承担哪一部分？",
        "发言人 2 10:06",
        "然后我负责前端架构。",
    ].join("\n");

    const result = parseTranscript(source);

    assert.equal(result.turns.length, 3);
    assert.equal(result.turns[0]?.content, "项目规模多大？");
    assert.equal(result.turns[1]?.content, "你承担哪一部分？");
    assert.equal(result.turns[2]?.content, "然后我负责前端架构。");
});

test("支持冒号同行内容和 CRLF，字符位置仍对应原文", () => {
    const source = "面试官：为什么这样设计？\r\n候选人: 因为需要兼容旧协议。\r\n";

    const result = parseTranscript(source);

    assert.equal(result.source, source);
    assert.equal(result.turns[0]?.content, "为什么这样设计？");
    assert.equal(result.turns[1]?.content, "因为需要兼容旧协议。");
    assert.equal(
        source.slice(result.turns[1]!.sourceStart, result.turns[1]!.sourceEnd),
        "候选人: 因为需要兼容旧协议。",
    );
});

test("没有角色标题时明确拒绝，而不是猜测角色", () => {
    assert.throws(
        () => parseTranscript("请介绍项目\n我做了性能优化"),
        /没有识别到说话人标题/,
    );
});
