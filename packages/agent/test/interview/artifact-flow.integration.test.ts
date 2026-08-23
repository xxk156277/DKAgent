import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryTraceStore, Tracer } from "@dkagent/trace";
import { AgentLoop } from "../../src/agent/loop.js";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";
import type { QuestionAnalysisArtifact } from "../../src/interview/artifact-payloads.js";
import type { ParsedTranscript, StructuredInterview } from "../../src/interview/types.js";
import type {
    LLMProvider,
    StreamEvent,
    StreamParams,
} from "../../src/query-engine/provider.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { ToolContext, ToolResult } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

class SingleToolCallProvider implements LLMProvider {
    public readonly name = "single-tool-call";
    public readonly requests: StreamParams[] = [];

    public constructor(private readonly input: Record<string, unknown>) { }

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        if (this.requests.length > 1) {
            throw new Error("终点 Tool 后不应再次请求模型");
        }
        yield {
            type: "tool_call_start",
            index: 0,
            id: "call-generate-report",
            name: "generate_report",
        };
        yield {
            type: "tool_call_delta",
            index: 0,
            argumentsDelta: JSON.stringify(this.input),
        };
        yield { type: "tool_call_end", index: 0 };
        yield {
            type: "message_end",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
        };
    }

    public async countTokens(): Promise<number> {
        return 0;
    }
}

type StructuredFailureMode =
    | "provider"
    | "json"
    | "zod"
    | "evidence"
    | "improvement"
    | "clarification";

function toolCallEvents(
    id: string,
    name: string,
    input: Record<string, unknown>,
): StreamEvent[] {
    return [
        { type: "tool_call_start", index: 0, id, name },
        {
            type: "tool_call_delta",
            index: 0,
            argumentsDelta: JSON.stringify(input),
        },
        { type: "tool_call_end", index: 0 },
        {
            type: "message_end",
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: "tool_use",
        },
    ];
}

function analysisFailureContent(mode: StructuredFailureMode, secret: string): string {
    if (mode === "json") return `${secret} not-json`;
    if (mode === "zod") {
        return JSON.stringify({ ...successfulAnalysisResponse, [secret]: true });
    }
    if (mode === "evidence") {
        return JSON.stringify({
            ...successfulAnalysisResponse,
            issues: [{
                ...successfulAnalysisResponse.issues[0],
                id: secret,
                evidenceTurnIds: [`${secret}-turnId`],
            }],
            improvements: [{ issueId: secret, text: "补充实现证据" }],
        });
    }
    if (mode === "improvement") {
        return JSON.stringify({
            ...successfulAnalysisResponse,
            improvements: [{ issueId: secret, text: "恶意改进项" }],
        });
    }
    if (mode === "clarification") {
        return JSON.stringify({
            ...successfulAnalysisResponse,
            clarificationCandidates: [{
                factKey: secret,
                question: "请补充证据",
                affectedQuestionIds: [`${secret}-questionId`],
                impact: "high",
            }],
        });
    }
    return JSON.stringify(successfulAnalysisResponse);
}

class StructuredFailureProvider implements LLMProvider {
    public readonly name = "structured-failure";
    public readonly requests: StreamParams[] = [];
    private ordinaryRequestCount = 0;

    public constructor(
        private readonly mode: StructuredFailureMode,
        private readonly secret: string,
        private readonly structuredInterviewArtifactId: string,
    ) { }

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        if (params.responseFormat === "json_object") {
            if (this.mode === "provider") throw new Error(this.secret);
            const content = analysisFailureContent(this.mode, this.secret);
            yield { type: "text_delta", content };
            yield {
                type: "message_end",
                usage: { inputTokens: 1, outputTokens: 1 },
                stopReason: "end_turn",
            };
            return;
        }

        this.ordinaryRequestCount += 1;
        if (this.ordinaryRequestCount === 1) {
            yield* toolCallEvents("call-analyze", "analyze_answer", {
                structuredInterviewArtifactId: this.structuredInterviewArtifactId,
                questionId: "question-0001",
            });
            return;
        }
        if (this.ordinaryRequestCount === 2) {
            const analyzeResult = latestToolResult(params);
            assert.equal(analyzeResult.success, true);
            yield* toolCallEvents("call-report", "generate_report", {
                structuredInterviewArtifactId: this.structuredInterviewArtifactId,
                analysisArtifactIds: [(analyzeResult.data as { artifactId: string }).artifactId],
                stage: "provisional",
                returnDirectly: true,
            });
            return;
        }
        throw new Error("安全错误报告后不应再请求模型");
    }

    public async countTokens(): Promise<number> {
        return 0;
    }

}

class StructureTurnIdFailureProvider implements LLMProvider {
    public readonly name = "structure-turn-id-failure";
    public readonly requests: StreamParams[] = [];
    private ordinaryRequestCount = 0;

    public constructor(
        private readonly transcriptArtifactId: string,
        private readonly secret: string,
    ) { }

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        if (params.responseFormat === "json_object") {
            yield {
                type: "text_delta",
                content: JSON.stringify({
                    clusters: [{
                        title: "恶意问题簇",
                        questions: [{
                            promptSegments: [{
                                turnId: this.secret,
                                text: "请介绍你的低代码项目。",
                            }],
                            answerTurnIds: ["turn-0002"],
                            questionType: "project",
                        }],
                    }],
                    nonQuestionTurnIds: [],
                }),
            };
            yield {
                type: "message_end",
                usage: { inputTokens: 1, outputTokens: 1 },
                stopReason: "end_turn",
            };
            return;
        }

        this.ordinaryRequestCount += 1;
        if (this.ordinaryRequestCount === 1) {
            yield* toolCallEvents("call-structure", "structure_interview", {
                transcriptArtifactId: this.transcriptArtifactId,
            });
            return;
        }
        if (this.ordinaryRequestCount === 2) {
            yield { type: "text_delta", content: "结构化失败已安全处理" };
            yield {
                type: "message_end",
                usage: { inputTokens: 1, outputTokens: 1 },
                stopReason: "end_turn",
            };
            return;
        }
        throw new Error("结构化失败后不应再请求模型");
    }

    public async countTokens(): Promise<number> {
        return 0;
    }
}

class SaveReportProvider implements LLMProvider {
    public readonly name = "save-report";
    public readonly requests: StreamParams[] = [];
    public reportMarkdown = "";
    private requestCount = 0;

    public constructor(
        private readonly structuredInterviewArtifactId: string,
        private readonly analysisArtifactId: string,
        private readonly reportPath: string,
    ) { }

    public async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
        this.requests.push(params);
        this.requestCount += 1;
        if (this.requestCount === 1) {
            yield* toolCallEvents("call-report", "generate_report", {
                structuredInterviewArtifactId: this.structuredInterviewArtifactId,
                analysisArtifactIds: [this.analysisArtifactId],
                stage: "provisional",
                returnDirectly: false,
            });
            return;
        }
        if (this.requestCount === 2) {
            const reportResult = latestToolResult(params);
            assert.equal(reportResult.success, true);
            this.reportMarkdown = (reportResult.data as { markdown: string }).markdown;
            yield* toolCallEvents("call-write", "write_file", {
                path: this.reportPath,
                content: this.reportMarkdown,
                overwrite: false,
            });
            return;
        }
        if (this.requestCount === 3) {
            yield { type: "text_delta", content: "报告已保存" };
            yield {
                type: "message_end",
                usage: { inputTokens: 1, outputTokens: 1 },
                stopReason: "end_turn",
            };
            return;
        }
        throw new Error("保存完成后不应再请求模型");
    }

    public async countTokens(): Promise<number> {
        return 0;
    }

}

function latestToolResult(params: StreamParams): ToolResult {
    const message = [...params.messages].reverse().find((item) => item.role === "tool");
    assert.ok(message?.content);
    return JSON.parse(message.content) as ToolResult;
}

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

function singleQuestionInterview(): StructuredInterview {
    return {
        transcript: {
            source,
            turns: [
                {
                    id: "turn-0001",
                    speaker: "interviewer",
                    speakerLabel: "面试官",
                    content: "请介绍你的低代码项目。",
                    sourceStart: 0,
                    sourceEnd: 12,
                },
                {
                    id: "turn-0002",
                    speaker: "candidate",
                    speakerLabel: "候选人",
                    content: sourceSentence,
                    sourceStart: 13,
                    sourceEnd: 13 + sourceSentence.length,
                },
            ],
        },
        clusters: [{
            id: "cluster-0001",
            title: "低代码项目",
            questionIds: ["question-0001"],
        }],
        questions: [{
            id: "question-0001",
            clusterId: "cluster-0001",
            promptTurnIds: ["turn-0001"],
            promptSegments: [{ turnId: "turn-0001", text: "请介绍你的低代码项目。" }],
            answerTurnIds: ["turn-0002"],
            originalQuestion: "请介绍你的低代码项目。",
            originalAnswer: sourceSentence,
            questionType: "project",
            scored: true,
            sourceStart: 0,
            sourceEnd: source.length,
        }],
        nonQuestionTurnIds: [],
    };
}

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
            queryEngine: new QueryEngine(provider, tracer),
            abortSignal: new AbortController().signal,
            tracer,
            artifactStore: artifacts,
        };

        await tracer.trace("agent.turn", { userInput: "分析面试" }, async (turn) => {
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
            event.name === "artifact.put" || event.name === "artifact.get"
        ));
        assert.ok(artifactEvents.length > 0);
        assert.ok(artifactEvents.every((event) => (
            event.name === "artifact.put" || event.name === "artifact.get"
        )));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes(sourceSentence)));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("originalAnswer")));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("strengths")));
        assert.ok(artifactEvents.every((event) => !JSON.stringify(event).includes("issues")));

        const modelEvents = traceStore.list().filter((event) => event.name === "model.generate");
        assert.ok(modelEvents.length > 0);
        const serializedModelEvents = JSON.stringify(modelEvents);
        assert.match(serializedModelEvents, /"systemPrompt":|"messages":|"content":/);
        assert.match(serializedModelEvents, /stopReason/);
        assert.equal(provider.remainingResponses, 0);
        turn.setOutput({ answer: "完成" });
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("AgentLoop 在失败题报告生成后直接返回 Tool 的完整 Markdown", async () => {
    const artifacts = new InMemoryArtifactStore();
    const structuredInterview: StructuredInterview = {
        transcript: {
            source,
            turns: [
                {
                    id: "turn-0001",
                    speaker: "interviewer",
                    speakerLabel: "面试官",
                    content: "请介绍你的低代码项目。",
                    sourceStart: 0,
                    sourceEnd: 12,
                },
                {
                    id: "turn-0002",
                    speaker: "candidate",
                    speakerLabel: "候选人",
                    content: sourceSentence,
                    sourceStart: 13,
                    sourceEnd: 13 + sourceSentence.length,
                },
            ],
        },
        clusters: [{ id: "cluster-0001", title: "低代码项目", questionIds: ["question-0001"] }],
        questions: [{
            id: "question-0001",
            clusterId: "cluster-0001",
            promptTurnIds: ["turn-0001"],
            promptSegments: [{ turnId: "turn-0001", text: "请介绍你的低代码项目。" }],
            answerTurnIds: ["turn-0002"],
            originalQuestion: "请介绍你的低代码项目。",
            originalAnswer: sourceSentence,
            questionType: "project",
            scored: true,
            sourceStart: 0,
            sourceEnd: source.length,
        }],
        nonQuestionTurnIds: [],
    };
    const structuredInterviewArtifactId = artifacts.put(
        "structured_interview",
        structuredInterview,
        { producer: "test" },
    );
    const analysisArtifactId = artifacts.put(
        "question_analysis",
        {
            structuredInterviewArtifactId,
            analysis: {
                status: "failed",
                questionId: "question-0001",
                clusterId: "cluster-0001",
                error: "模型 JSON 无效",
            },
        } satisfies QuestionAnalysisArtifact,
        { producer: "test" },
    );
    const provider = new SingleToolCallProvider({
        structuredInterviewArtifactId,
        analysisArtifactIds: [analysisArtifactId],
        stage: "provisional",
    });
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider),
        toolRegistry: createToolRegistry({ model: "fake-model" }),
        contextManager: {
            async build(input) {
                return {
                    messages: [...input.messages],
                    tools: [...input.tools],
                };
            },
        },
        model: "fake-model",
        maxContextTokens: 10_000,
        maxOutputTokens: 1_000,
        artifactStore: artifacts,
    });

    const answer = await agent.run("生成报告");
    const messages = agent.getMessages();
    const toolMessage = messages.find((message) => message.role === "tool");
    assert.ok(toolMessage?.content);
    const toolResult = JSON.parse(toolMessage.content) as ToolResult<{
        markdown: string;
    }>;

    assert.equal(provider.requests.length, 1);
    assert.equal(toolResult.success, true);
    assert.equal(answer, toolResult.data?.markdown);
    assert.deepEqual(messages.at(-1), { role: "assistant", content: answer });
    assert.match(answer, /### Q1/);
    assert.match(answer, /模型 JSON 无效/);
    assert.match(answer, new RegExp(sourceSentence));
    assert.doesNotMatch(answer, /因篇幅省略/);
});

test("Provider、JSON、Zod 和业务校验错误不进入 Tool、Trace、Failed Artifact 或报告", async () => {
    for (const [mode, expectedSafeError] of [
        ["provider", "结构化模型请求失败"],
        ["json", "结构化模型输出无效"],
        ["zod", "结构化模型输出无效"],
        ["evidence", "回答分析失败"],
        ["improvement", "回答分析失败"],
        ["clarification", "回答分析失败"],
    ] as const) {
        const secret = `STRUCTURED_${mode.toUpperCase()}_SECRET_20260822`;
        const traceStore = new MemoryTraceStore();
        const tracer = new Tracer(traceStore);
        const artifacts = new InMemoryArtifactStore(tracer);
        const structuredInterviewArtifactId = artifacts.put(
            "structured_interview",
            singleQuestionInterview(),
            { producer: "test" },
        );
        const provider = new StructuredFailureProvider(
            mode,
            secret,
            structuredInterviewArtifactId,
        );
        const agent = new AgentLoop({
            queryEngine: new QueryEngine(provider, tracer),
            toolRegistry: createToolRegistry({ model: "fake-model" }),
            contextManager: {
                async build(input) {
                    return { messages: [...input.messages], tools: [...input.tools] };
                },
            },
            model: "fake-model",
            maxContextTokens: 10_000,
            maxOutputTokens: 1_000,
            artifactStore: artifacts,
            tracer,
        });

        const answer = await agent.run("分析安全错误");
        const toolResults = agent.getMessages()
            .filter((message) => message.role === "tool")
            .map((message) => JSON.parse(message.content) as ToolResult);
        const analyzeResult = toolResults[0]!;
        assert.equal(analyzeResult.success, true);
        const failedArtifact = artifacts.get<QuestionAnalysisArtifact>(
            (analyzeResult.data as { artifactId: string }).artifactId,
            "question_analysis",
            "test",
        );
        assert.equal(failedArtifact.analysis.status, "failed");
        assert.equal(failedArtifact.analysis.error, expectedSafeError);
        assert.match(answer, new RegExp(expectedSafeError));

        for (const downstream of [
            JSON.stringify(toolResults),
            JSON.stringify(failedArtifact),
            answer,
        ]) {
            assert.doesNotMatch(downstream, new RegExp(secret));
        }
    }
});

test("structure_interview 业务校验不泄露模型可控 turnId", async () => {
    const secret = "STRUCTURE_TURN_ID_SECRET_20260822";
    const traceStore = new MemoryTraceStore();
    const tracer = new Tracer(traceStore);
    const artifacts = new InMemoryArtifactStore(tracer);
    const interview = singleQuestionInterview();
    const transcriptArtifactId = artifacts.put(
        "parsed_transcript",
        interview.transcript satisfies ParsedTranscript,
        { producer: "test" },
    );
    const artifactCountBefore = traceStore.list().filter(
        (event) => event.name === "artifact.put",
    ).length;
    const provider = new StructureTurnIdFailureProvider(transcriptArtifactId, secret);
    const agent = new AgentLoop({
        queryEngine: new QueryEngine(provider, tracer),
        toolRegistry: createToolRegistry({ model: "fake-model" }),
        contextManager: {
            async build(input) {
                return { messages: [...input.messages], tools: [...input.tools] };
            },
        },
        model: "fake-model",
        maxContextTokens: 10_000,
        maxOutputTokens: 1_000,
        artifactStore: artifacts,
        tracer,
    });

    const answer = await agent.run("结构化面试");
    const toolResult = JSON.parse(
        agent.getMessages().find((message) => message.role === "tool")!.content,
    ) as ToolResult;
    assert.equal(toolResult.success, false);
    assert.equal(toolResult.error?.message, "面试问题结构化失败");
    const modelSpans = traceStore.list().filter((event) => event.name === "model.generate"
        && (event.input as { responseFormat?: string }).responseFormat === "json_object");
    assert.equal(modelSpans.length, 1);
    const modelSpan = modelSpans[0]!;
    const parent = traceStore.list().find((event) => event.spanId === modelSpan.parentSpanId);
    assert.equal(parent?.name, "tool.execute");
    assert.deepEqual((modelSpan.input as { responseFormat?: string }).responseFormat, "json_object");
    assert.equal((modelSpan.input as { thinking?: string }).thinking, "disabled");
    assert.equal(typeof modelSpan.durationMs, "number");
    assert.deepEqual(modelSpan.tokenUsage, { inputTokens: 1, outputTokens: 1 });
    assert.equal(
        traceStore.list().filter((event) => event.name === "artifact.put").length,
        artifactCountBefore,
    );
    for (const downstream of [
        JSON.stringify(toolResult),
        answer,
    ]) {
        assert.doesNotMatch(downstream, new RegExp(secret));
    }
});

test("AgentLoop 同 Turn 在 generate_report(false) 后将完整报告写入新文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dkagent-save-report-"));
    try {
        const artifacts = new InMemoryArtifactStore();
        const structuredInterviewArtifactId = artifacts.put(
            "structured_interview",
            singleQuestionInterview(),
            { producer: "test" },
        );
        const analysisArtifactId = artifacts.put(
            "question_analysis",
            {
                structuredInterviewArtifactId,
                analysis: {
                    status: "failed",
                    questionId: "question-0001",
                    clusterId: "cluster-0001",
                    error: "结构化模型输出无效",
                },
            } satisfies QuestionAnalysisArtifact,
            { producer: "test" },
        );
        const provider = new SaveReportProvider(
            structuredInterviewArtifactId,
            analysisArtifactId,
            "saved-report.md",
        );
        const agent = new AgentLoop({
            queryEngine: new QueryEngine(provider),
            toolRegistry: createToolRegistry({ cwd: directory, model: "fake-model" }),
            contextManager: {
                async build(input) {
                    return { messages: [...input.messages], tools: [...input.tools] };
                },
            },
            model: "fake-model",
            maxContextTokens: 100_000,
            maxOutputTokens: 20_000,
            maxSteps: 4,
            artifactStore: artifacts,
        });

        assert.equal(await agent.run("分析并保存报告"), "报告已保存");
        const saved = await readFile(join(directory, "saved-report.md"), "utf8");
        assert.equal(saved, provider.reportMarkdown);
        assert.match(saved, /面试分析报告/);
        assert.match(saved, new RegExp(sourceSentence));
        assert.equal(provider.requests.length, 3);
        assert.deepEqual(agent.getMessages().map((message) => message.role), [
            "user",
            "assistant",
            "tool",
            "assistant",
            "tool",
            "assistant",
        ]);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
