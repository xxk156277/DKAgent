import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";
import type { QuestionAnalysisArtifact } from "../../src/interview/artifact-payloads.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const sourceSentence = "我负责低代码 DSL 渲染链路，并把首屏耗时降低了百分之三十。";
const source = [
    "面试官 00:01",
    "请介绍你的低代码项目。",
    "候选人 00:02",
    sourceSentence,
    "面试官 00:03",
    "为什么选择 DSL？",
    "候选人 00:04",
    "因为需要兼容多个业务协议。",
].join("\n");

const structureResponse = {
    clusters: [
        {
            title: "低代码项目",
            questions: [{
                promptSegments: [{ turnId: "turn-0001", text: "请介绍你的低代码项目。" }],
                answerTurnIds: ["turn-0002"],
                questionType: "project",
            }],
        },
        {
            title: "DSL 选型",
            questions: [{
                promptSegments: [{ turnId: "turn-0003", text: "为什么选择 DSL？" }],
                answerTurnIds: ["turn-0004"],
                questionType: "project",
            }],
        },
    ],
    nonQuestionTurnIds: [],
};

const successfulAnalysisResponse = {
    strengths: [{
        id: "strength-1",
        text: "说明了个人职责和量化结果",
        impact: "能够判断候选人的直接贡献",
        evidenceTurnIds: ["turn-0002"],
    }],
    issues: [{
        id: "issue-1",
        text: "缺少实现细节",
        impact: "难以判断方案深度",
        evidenceTurnIds: ["turn-0002"],
    }],
    improvements: [{ issueId: "issue-1", text: "补充关键实现和约束" }],
    dimensions: {
        contentQuality: 80,
        depthAndEvidence: 70,
        analysisAndTradeoffs: 65,
        followUpHandling: null,
        expressionQuality: 75,
    },
    confidence: 0.82,
    confidenceReason: "原回答包含职责和结果证据",
    clarificationCandidates: [],
};

const summaryResponse = {
    levelSummary: "项目表达较清晰，但技术决策细节仍需补充。",
    strengths: [{ text: "职责和结果较明确", questionIds: ["question-0001"] }],
    coreIssues: [{ text: "第二题分析失败，当前证据不完整", questionIds: ["question-0002"] }],
    priorityImprovements: [{ text: "补充方案约束和取舍", questionIds: ["question-0001"] }],
};

function requireData<T>(result: ToolResult<T>): T {
    assert.equal(result.success, true, result.error?.message ?? "Tool 应成功");
    assert.ok(result.data);
    return result.data;
}

test("Tool Registry Artifact 引用链隐藏中间大对象并在单题模型失败后生成报告", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-artifact-flow-"));
    try {
        await writeFile(join(directory, "interview.md"), source, "utf8");
        const traceStore = new MemoryTraceStore();
        const tracer = new Tracer(traceStore);
        const artifacts = new InMemoryArtifactStore(tracer);
        const provider = new FakeTextProvider([
            JSON.stringify(structureResponse),
            JSON.stringify(successfulAnalysisResponse),
            "not-json",
            JSON.stringify(summaryResponse),
        ]);
        const registry = createToolRegistry({ cwd: directory, model: "fake-model" });
        const context: ToolContext = {
            queryEngine: new QueryEngine(provider),
            abortSignal: new AbortController().signal,
            tracer,
            artifactStore: artifacts,
        };

        const readResult = await registry.resolve("read_file").execute(
            { path: "interview.md", storeAsArtifact: true },
            context,
        );
        const readData = requireData<{ artifactId: string }>(readResult);
        const parseResult = await registry.resolve("parse_transcript").execute(
            { sourceArtifactId: readData.artifactId },
            context,
        );
        const parseData = requireData<{ artifactId: string }>(parseResult);
        const structureResult = await registry.resolve("structure_interview").execute(
            { transcriptArtifactId: parseData.artifactId },
            context,
        );
        const structureData = requireData<{ artifactId: string; questionIds: string[] }>(
            structureResult,
        );

        const analyzeResults = [];
        for (const questionId of structureData.questionIds) {
            analyzeResults.push(await registry.resolve("analyze_answer").execute({
                structuredInterviewArtifactId: structureData.artifactId,
                questionId,
            }, context));
        }
        const analyzeData = analyzeResults.map((result) => requireData<{
            artifactId: string;
            status: "completed" | "failed" | "not_scored";
        }>(result));
        const failed = analyzeData.find((item) => item.status === "failed");
        assert.ok(failed);
        assert.equal(
            artifacts.get<QuestionAnalysisArtifact>(
                failed.artifactId,
                "question_analysis",
                "test",
            ).analysis.status,
            "failed",
        );

        const reportResult = await registry.resolve("generate_report").execute({
            structuredInterviewArtifactId: structureData.artifactId,
            analysisArtifactIds: analyzeData.map((item) => item.artifactId),
            stage: "provisional",
        }, context);
        const reportData = requireData<{
            report: { score: { coverage: { analyzed: number; expected: number } } };
            markdown: string;
        }>(reportResult);

        assert.equal(JSON.stringify(readResult).includes(sourceSentence), false);
        assert.equal(JSON.stringify(parseResult).includes(sourceSentence), false);
        assert.equal(JSON.stringify(structureResult).includes("originalAnswer"), false);
        assert.ok(analyzeResults.every((item) => !JSON.stringify(item).includes("strengths")));
        assert.ok(analyzeResults.every((item) => !JSON.stringify(item).includes("issues")));
        assert.equal(reportData.report.score.coverage.analyzed, 1);
        assert.equal(reportData.report.score.coverage.expected, 2);
        assert.match(reportData.markdown, /面试分析报告/);
        assert.match(reportData.markdown, new RegExp(sourceSentence));

        const artifactEvents = traceStore.list().filter((event) => (
            event.name === "artifact.created" || event.name === "artifact.resolved"
        ));
        assert.ok(artifactEvents.length > 0);
        assert.ok(artifactEvents.every((event) => event.module === "artifact"));
        const allowedTraceFields = new Set([
            "artifactId",
            "artifactType",
            "producer",
            "consumer",
            "characterCount",
            "itemCount",
            "exposedCharacterCount",
            "omittedCharacterCount",
            "hit",
        ]);
        assert.ok(artifactEvents.every((event) => (
            typeof event.data === "object"
            && event.data !== null
            && Object.keys(event.data).every((key) => allowedTraceFields.has(key))
        )));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes(sourceSentence)));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("originalAnswer")));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("strengths")));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("issues")));

        const modelEvents = traceStore.list().filter((event) => (
            event.name === "model.request" || event.name === "model.response"
        ));
        assert.ok(modelEvents.length > 0);
        assert.ok(modelEvents.every((event) => event.module === "skill"));
        const serializedModelEvents = JSON.stringify(modelEvents);
        assert.doesNotMatch(serializedModelEvents, new RegExp(sourceSentence));
        assert.doesNotMatch(serializedModelEvents, /originalAnswer|"strengths"|"issues"/);
        assert.doesNotMatch(
            serializedModelEvents,
            /"systemPrompt":|"messages":|"content":/,
        );
        assert.match(serializedModelEvents, /systemPromptCharacterCount/);
        assert.match(serializedModelEvents, /userContentCharacterCount/);
        assert.match(serializedModelEvents, /resultType/);
        assert.match(serializedModelEvents, /stopReason/);
        assert.equal(provider.remainingResponses, 0);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
