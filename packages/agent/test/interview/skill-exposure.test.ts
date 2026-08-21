import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
    assert.match(content, /默认不得调用 `write_file`/);
    assert.match(content, /overwrite: false/);
});

test("ToolRegistry 暴露原子分析能力且不再暴露 analyze_interview", () => {
    const registry = createToolRegistry({ model: "fake-model" });
    const names = registry.list().map((tool) => tool.name);

    assert.equal(names.includes("analyze_interview"), false);
    for (const name of [
        "parse_transcript",
        "preprocess_transcript",
        "structure_interview",
        "extract_project_facts",
        "analyze_expression",
        "analyze_answer",
        "generate_report",
    ]) {
        assert.equal(names.includes(name), true, `缺少原子 Tool: ${name}`);
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
    const context: ToolContext = {
        queryEngine: new QueryEngine(new FakeTextProvider(JSON.stringify(relation))),
        abortSignal: new AbortController().signal,
    };
    const registry = createToolRegistry({ model: "fake-model" });

    const parsed = await registry.resolve("parse_transcript").execute({ content: source }, context);
    assert.equal(parsed.success, true);
    const transcript = parsed.data as { turns: unknown[] };
    const structured = await registry.resolve("structure_interview").execute({
        transcript: parsed.data,
        correctedTurns: transcript.turns,
    }, context);

    assert.equal(structured.success, true);
    assert.equal((structured.data as { questions: unknown[] }).questions.length, 1);
});

test("参考资料能力仅在 Retriever 存在时暴露", async () => {
    const withoutRetriever = createToolRegistry({ model: "fake-model" });
    assert.equal(withoutRetriever.has("search_interview_reference"), false);

    const withRetriever = createToolRegistry({
        model: "fake-model",
        referenceRetriever: {
            async search(question) {
                return [`参考：${question}`];
            },
        },
    });
    assert.equal(withRetriever.has("search_interview_reference"), true);

    const result = await withRetriever.resolve("search_interview_reference").execute(
        { question: "事件循环是什么" },
        {
            queryEngine: {} as QueryEngine,
            abortSignal: new AbortController().signal,
        },
    );
    assert.deepEqual(result.data, { references: ["参考：事件循环是什么"] });
});
