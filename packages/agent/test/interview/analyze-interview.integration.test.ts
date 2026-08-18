import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const expression = {
    impact: "none", detail: "表达可理解", evidenceQuotes: [], score: 80, confidence: 0.9,
};

function answer(questionId: string, turnId: string, project: boolean) {
    return {
        strengths: [{ id: `${questionId}-s1`, text: "回答了核心问题", impact: "内容有效", evidenceTurnIds: [turnId] }],
        issues: [{ id: `${questionId}-i1`, text: "证据深度有限", impact: "难以充分验证", evidenceTurnIds: [turnId] }],
        improvements: [{ issueId: `${questionId}-i1`, text: "补充依据与结果" }],
        dimensions: {
            contentQuality: 80,
            depthAndEvidence: 70,
            analysisAndTradeoffs: project ? 75 : null,
            followUpHandling: null,
        },
        confidence: 0.8,
        confidenceReason: "可回到原文",
        clarificationCandidates: [],
    };
}

test("真实 Registry 分析 500 行以上文字稿并写出完整暂定报告", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-interview-"));
    try {
        const transcriptPath = join(directory, "字节一面.md");
        const longAnswer = ["我负责低代码渲染链路。", ...Array.from({ length: 501 }, (_, i) => `项目细节 ${i + 1}`)].join("\n");
        await writeFile(transcriptPath, [
            "面试官：请介绍你的低代码项目",
            `候选人：${longAnswer}`,
            "面试官：解释事件循环",
            "候选人：宏任务后执行微任务。",
            "面试官：你还有问题吗",
            "候选人：没有了。",
        ].join("\n"), "utf8");

        const responses = [
            { corrections: [] },
            {
                clusters: [
                    { id: "cluster-project", title: "低代码项目", questionIds: ["q-1"] },
                    { id: "cluster-knowledge", title: "事件循环", questionIds: ["q-2"] },
                    { id: "cluster-procedural", title: "结束流程", questionIds: ["q-3"] },
                ],
                questions: [
                    { id: "q-1", clusterId: "cluster-project", promptSegments: [{ turnId: "turn-0001", text: "请介绍你的低代码项目" }], answerTurnIds: ["turn-0002"], questionType: "project", scored: true },
                    { id: "q-2", clusterId: "cluster-knowledge", promptSegments: [{ turnId: "turn-0003", text: "解释事件循环" }], answerTurnIds: ["turn-0004"], questionType: "knowledge", scored: true },
                    { id: "q-3", clusterId: "cluster-procedural", promptSegments: [{ turnId: "turn-0005", text: "你还有问题吗" }], answerTurnIds: ["turn-0006"], questionType: "procedural", scored: false },
                ],
                nonQuestionTurnIds: [],
            },
            { facts: [{ localKey: "role", category: "responsibility", value: "负责低代码渲染链路", status: "stated", evidenceTurnIds: ["turn-0002"], evidenceQuote: "我负责低代码渲染链路", affectedQuestionIds: ["q-1"], clarificationQuestion: null, impact: "high" }] },
            expression,
            answer("q-1", "turn-0002", true),
            expression,
            answer("q-2", "turn-0004", false),
            { levelSummary: "整体达到中级水平。", strengths: [{ text: "项目职责明确", questionIds: ["q-1"] }], coreIssues: [{ text: "知识深度有限", questionIds: ["q-2"] }], priorityImprovements: [{ text: "补充原理与证据", questionIds: ["q-2"] }] },
        ];
        const provider = new FakeTextProvider(responses.map((response) => JSON.stringify(response)));
        const registry = createToolRegistry({
            cwd: directory,
            model: "fake-model",
            now: () => new Date(2026, 7, 18, 10, 20, 30),
        });
        const traceStore = new MemoryTraceStore();
        const context: ToolContext = {
            queryEngine: new QueryEngine(provider),
            abortSignal: new AbortController().signal,
            tracer: new Tracer(traceStore),
        };
        const result = await registry.resolve("analyze_interview").execute({
            transcriptPath,
            metadata: { company: "字节跳动", round: "一面" },
        }, context);

        assert.equal(result.success, true);
        assert.equal(result.data?.questionCount, 3);
        assert.equal(result.data?.analyzedCount, 2);
        assert.match(result.data?.reportPath ?? "", /20260818-102030\.md$/);
        const markdown = await readFile(result.data!.reportPath, "utf8");
        assert.match(markdown, /项目细节 501/);
        assert.match(markdown, /原问题：你还有问题吗/);
        assert.match(markdown, /分数：不参与评分/);
        assert.equal(provider.remainingResponses, 0);

        const traceEvents = traceStore.list();
        assert.ok(traceEvents.some((event) => event.name === "skill.run"));
        assert.ok(traceEvents.some((event) => (
            event.name === "skill.stage" && event.operation === "analyze_answer"
        )));
        assert.equal(
            traceEvents.filter((event) => (
                event.name === "model.request" && event.phase === "start"
            )).length,
            8,
        );
        assert.equal(
            traceEvents.filter((event) => event.name === "model.response").length,
            8,
        );
        assert.equal(
            traceEvents.filter((event) => event.name === "tool.call").length,
            0,
        );

        const invalidJsonStore = new MemoryTraceStore();
        const invalidJsonRegistry = createToolRegistry({
            cwd: directory,
            model: "fake-model",
        });
        const invalidJsonResult = await invalidJsonRegistry.resolve("analyze_interview").execute({
            transcriptPath,
        }, {
            queryEngine: new QueryEngine(new FakeTextProvider(["not-json"])),
            abortSignal: new AbortController().signal,
            tracer: new Tracer(invalidJsonStore),
        });
        assert.equal(invalidJsonResult.success, false);
        const requestError = invalidJsonStore.list().find((event) => (
            event.name === "model.request" && event.phase === "error"
        ));
        assert.ok(requestError?.spanId);
        assert.ok(invalidJsonStore.list().some((event) => (
            event.name === "model.response" && event.spanId === requestError.spanId
        )));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
