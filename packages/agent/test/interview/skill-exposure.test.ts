import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryArtifactStore } from "../../src/artifact/index.js";
import type { ParsedTranscript, StructuredInterview } from "../../src/interview/types.js";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { appendAvailableSkills } from "../../src/skills/prompt.js";
import { createSkillRegistry } from "../../src/skills/registry.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const source = [
    "面试官：请介绍项目",
    "候选人：我负责渲染链路。",
].join("\n");

test("diagnose-transcript 只把元数据注入系统 Prompt", async () => {
    const skills = createSkillRegistry();
    const prompt = appendAvailableSkills("稳定系统规则", skills);

    assert.equal(skills.length, 1);
    assert.match(prompt, /<available_skills>/);
    assert.match(prompt, /diagnose-transcript/);
    assert.match(prompt, /SKILL\.md/);
    assert.doesNotMatch(prompt, /# Diagnose Transcript/);

    const content = await readFile(skills[0]!.location, "utf8");
    assert.match(content, /generate_report/);
    assert.doesNotMatch(content, /preprocess_transcript/);
    assert.doesNotMatch(content, /extract_project_facts/);
    assert.doesNotMatch(content, /analyze_expression/);
    assert.match(content, /默认不得调用 `write_file`/);
    assert.match(content, /overwrite: false/);
    assert.match(content, /returnDirectly: true/);
    assert.match(content, /returnDirectly: false/);
    for (const reference of [
        "storeAsArtifact: true",
        "sourceArtifactId",
        "transcriptArtifactId",
        "structuredInterviewArtifactId",
        "questionId",
        "analysisArtifactIds",
    ]) {
        assert.match(content, new RegExp(reference));
    }
    assert.doesNotMatch(content, /输入完整文字稿内容/);
    assert.doesNotMatch(content, /只输入 `transcript`/);
    assert.doesNotMatch(content, /传入 `structuredInterview`、`analyses`/);
    assert.doesNotMatch(content, /继续分页/);
});

test("ToolRegistry 暴露原子分析能力且不再暴露 analyze_interview", () => {
    const registry = createToolRegistry({ model: "fake-model" });
    const names = registry.list().map((tool) => tool.name);

    assert.equal(names.includes("analyze_interview"), false);
    for (const name of ["parse_transcript", "structure_interview", "analyze_answer", "generate_report"]) {
        assert.equal(names.includes(name), true, `缺少原子 Tool: ${name}`);
    }
    for (const name of ["preprocess_transcript", "extract_project_facts", "analyze_expression"]) {
        assert.equal(names.includes(name), false, `不应暴露停用 Tool: ${name}`);
    }
});

test("parse_transcript 和 structure_interview 通过 Tool 契约串联", async () => {
    const relation = {
        clusters: [{
            title: "项目",
            questions: [{
                promptSegments: [{ turnId: "turn-0001", text: "请介绍项目" }],
                answerTurnIds: ["turn-0002"],
                questionType: "project",
            }],
        }],
        nonQuestionTurnIds: [],
    };
    const artifacts = new InMemoryArtifactStore();
    const context: ToolContext = {
        queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify(relation))),
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };
    const registry = createToolRegistry({ model: "fake-model" });

    const sourceArtifactId = artifacts.put("file_text", source, { producer: "test" });
    const parsed = await registry.resolve("parse_transcript").execute({ sourceArtifactId }, context);
    assert.equal(parsed.success, true);
    assert.equal("transcript" in (parsed.data ?? {}), false);
    assert.equal(parsed.data?.turnCount, 2);
    const transcript = artifacts.get<ParsedTranscript>(
        parsed.data!.artifactId,
        "parsed_transcript",
        "test",
    );
    assert.equal(transcript.turns.length, 2);
    const structured = await registry.resolve("structure_interview").execute({
        transcriptArtifactId: parsed.data!.artifactId,
    }, context);

    assert.equal(structured.success, true);
    assert.deepEqual(structured.data?.questionIds, ["question-0001"]);
    assert.equal("questions" in (structured.data ?? {}), false);
    const interview = artifacts.get<StructuredInterview>(
        structured.data!.artifactId,
        "structured_interview",
        "test",
    );
    assert.equal(interview.questions.length, 1);
});

test("structure_interview 将 Artifact 读取失败作为输入错误", async () => {
    const artifacts = new InMemoryArtifactStore();
    const context: ToolContext = {
        queryEngine: {} as QueryEngine,
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };
    const tool = createToolRegistry({ model: "fake-model" }).resolve("structure_interview");

    const missing = await tool.execute({ transcriptArtifactId: "missing" }, context);
    assert.equal(missing.success, false);
    assert.equal(missing.error?.code, "input_error");

    const wrongKindId = artifacts.put("file_text", source, { producer: "test" });
    const wrongKind = await tool.execute({ transcriptArtifactId: wrongKindId }, context);
    assert.equal(wrongKind.success, false);
    assert.equal(wrongKind.error?.code, "input_error");
});

test("structure_interview 将模型请求中止返回为 timeout", async () => {
    const artifacts = new InMemoryArtifactStore();
    const transcriptArtifactId = artifacts.put("parsed_transcript", {
        source,
        turns: [
            {
                id: "turn-0001",
                speaker: "interviewer",
                speakerLabel: "面试官",
                content: "请介绍项目",
                sourceStart: 0,
                sourceEnd: 9,
            },
            {
                id: "turn-0002",
                speaker: "candidate",
                speakerLabel: "候选人",
                content: "我负责渲染链路。",
                sourceStart: 10,
                sourceEnd: source.length,
            },
        ],
    } satisfies ParsedTranscript, { producer: "test" });
    const context: ToolContext = {
        queryEngine: {
            async query() {
                throw Object.assign(new Error("不应泄露"), { code: "ABORT_ERR" });
            },
        } as unknown as QueryEngine,
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };

    const result = await createToolRegistry({ model: "fake-model" })
        .resolve("structure_interview")
        .execute({ transcriptArtifactId }, context);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "timeout");
    assert.equal(result.error?.message, "操作已中止");
});

test("parse_transcript 将不存在的 Artifact ID 作为输入错误", async () => {
    const artifacts = new InMemoryArtifactStore();
    const context: ToolContext = {
        queryEngine: {} as QueryEngine,
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };

    const result = await createToolRegistry({ model: "fake-model" })
        .resolve("parse_transcript")
        .execute({ sourceArtifactId: "missing" }, context);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

test("parse_transcript 将错误的 Artifact 类型作为输入错误", async () => {
    const artifacts = new InMemoryArtifactStore();
    const context: ToolContext = {
        queryEngine: {} as QueryEngine,
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };
    const sourceArtifactId = artifacts.put("parsed_transcript", { turns: [] }, { producer: "test" });

    const result = await createToolRegistry({ model: "fake-model" })
        .resolve("parse_transcript")
        .execute({ sourceArtifactId }, context);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

test("parse_transcript 将无法解析的 Artifact 文字稿作为输入错误", async () => {
    const artifacts = new InMemoryArtifactStore();
    const context: ToolContext = {
        queryEngine: {} as QueryEngine,
        abortSignal: new AbortController().signal,
        artifactStore: artifacts,
    };
    const sourceArtifactId = artifacts.put("file_text", "没有说话人标题", { producer: "test" });

    const result = await createToolRegistry({ model: "fake-model" })
        .resolve("parse_transcript")
        .execute({ sourceArtifactId }, context);

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "input_error");
});

/*
 * 最小流程不包含参考资料检索。原“参考资料能力仅在 Retriever 存在时暴露”测试
 * 整段停用，待该能力重新进入工作流时恢复。
 */
