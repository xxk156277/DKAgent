import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscript } from "../../src/interview/transcript-parser.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createPreprocessTranscriptTool } from "../../src/tools/tool-item/preprocess-transcript.js";
import { FakeTextProvider } from "./fake-provider.js";

test("只应用高置信且能精确定位的纠错，并保持原文不可变", async () => {
    const transcript = parseTranscript([
        "面试官 00:01",
        "说说你的项目。",
        "候选人 00:02",
        "嗯，我用了 reat，然后然后做了性能优化。",
    ].join("\n"));
    const sourceBefore = transcript.source;
    const turnsBefore = structuredClone(transcript.turns);
    const response = JSON.stringify({ corrections: [
        {
            turnId: "turn-0002",
            original: "reat",
            replacement: "React",
            confidence: 0.98,
            reason: "技术名词误识别",
        },
        {
            turnId: "turn-0002",
            original: "嗯，我",
            replacement: "我",
            confidence: 0.99,
            reason: "删除口头语",
        },
        {
            turnId: "turn-0002",
            original: "然后然后",
            replacement: "然后",
            confidence: 0.99,
            reason: "消除重复",
        },
        {
            turnId: "turn-0002",
            original: "不存在",
            replacement: "TypeScript",
            confidence: 0.99,
            reason: "猜测",
        },
        {
            turnId: "turn-0002",
            original: "性能",
            replacement: "首屏性能",
            confidence: 0.8,
            reason: "置信度不足",
        },
    ] });
    const provider = new FakeTextProvider(response);
    const tool = createPreprocessTranscriptTool("fake-model");

    const result = await tool.execute({ transcript }, {
        queryEngine: new QueryEngine(provider),
        abortSignal: new AbortController().signal,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data?.corrections.map((item) => item.original), ["reat"]);
    assert.equal(
        result.data?.correctedTurns[1]?.content,
        "嗯，我用了 React，然后然后做了性能优化。",
    );
    assert.equal(transcript.source, sourceBefore);
    assert.deepEqual(transcript.turns, turnsBefore);
    assert.match(provider.request?.systemPrompt ?? "", /不得.*口头语/);
});

test("模型返回非法 JSON 时返回 service_error", async () => {
    const transcript = parseTranscript("面试官\n问题\n候选人\n回答");
    const tool = createPreprocessTranscriptTool("fake-model");

    const result = await tool.execute({ transcript }, {
        queryEngine: new QueryEngine(new FakeTextProvider("不是 JSON")),
        abortSignal: new AbortController().signal,
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "service_error");
});

test("保护标点分隔卡壳和显式停顿痕迹", async () => {
    const transcript = parseTranscript([
        "面试官",
        "你负责什么？",
        "候选人",
        "我，我负责前端，这个…方案用了 reat。",
    ].join("\n"));
    const response = JSON.stringify({ corrections: [
        {
            turnId: "turn-0002",
            original: "我，我负责前端",
            replacement: "我负责前端",
            confidence: 0.99,
            reason: "删除卡壳",
        },
        {
            turnId: "turn-0002",
            original: "这个…方案",
            replacement: "这个方案",
            confidence: 0.99,
            reason: "删除停顿",
        },
        {
            turnId: "turn-0002",
            original: "reat",
            replacement: "React",
            confidence: 0.99,
            reason: "技术名词误识别",
        },
    ] });

    const result = await createPreprocessTranscriptTool("fake-model").execute(
        { transcript },
        {
            queryEngine: new QueryEngine(new FakeTextProvider(response)),
            abortSignal: new AbortController().signal,
        },
    );

    assert.deepEqual(
        result.data?.corrections.map((item) => item.original),
        ["reat"],
    );
    assert.equal(
        result.data?.correctedTurns[1]?.content,
        "我，我负责前端，这个…方案用了 React。",
    );
});

test("接受 JSON 代码围栏但拒绝额外字段", async () => {
    const transcript = parseTranscript("面试官\n问题\n候选人\n回答");
    const fenced = "```json\n{\"corrections\": [], \"unexpected\": true}\n```";
    const tool = createPreprocessTranscriptTool("fake-model");

    const result = await tool.execute({ transcript }, {
        queryEngine: new QueryEngine(new FakeTextProvider(fenced)),
        abortSignal: new AbortController().signal,
    });

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "service_error");
});
