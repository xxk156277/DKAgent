import assert from "node:assert/strict";
import test from "node:test";
import { QueryEngine } from "../../src/query-engine/query-engine.js";
import { createPreprocessTranscriptTool } from "../../src/tools/tool-item/preprocess-transcript.js";
import type { ToolContext } from "../../src/tools/types.js";
import { FakeTextProvider } from "./fake-provider.js";

const transcript = {
    source: "候选人：我使用reat开发前端页面",
    turns: [{
        id: "turn-0001",
        speaker: "candidate" as const,
        content: "我使用reat开发前端页面",
        sourceStart: 0,
        sourceEnd: 20,
    }],
};

function context(provider: FakeTextProvider): ToolContext {
    return {
        queryEngine: new QueryEngine(provider),
        abortSignal: new AbortController().signal,
    };
}

test("纠错 Prompt 明确 JSON 字段、完整示例和空结果示例", async () => {
    const provider = new FakeTextProvider('{"corrections":[]}');
    const result = await createPreprocessTranscriptTool("deepseek-v4-pro").execute(
        { transcript },
        context(provider),
    );

    assert.equal(result.success, true);
    const prompt = provider.request?.systemPrompt ?? "";
    assert.match(prompt, /EXAMPLE INPUT:/);
    assert.match(prompt, /EXAMPLE JSON OUTPUT:/);
    assert.match(prompt, /NO CORRECTION JSON OUTPUT:/);
    assert.match(prompt, /"turnId"/);
    assert.match(prompt, /"original"/);
    assert.match(prompt, /"replacement"/);
    assert.match(prompt, /"confidence": 0\.98/);
    assert.match(prompt, /"reason"/);
    assert.match(prompt, /不得使用 Markdown 代码块/);
});

test("json_object 后仍使用 Zod strict 拒绝额外字段", async () => {
    const provider = new FakeTextProvider(
        '{"corrections":[],"unexpected":"invalid"}',
    );
    const result = await createPreprocessTranscriptTool("deepseek-v4-pro").execute(
        { transcript },
        context(provider),
    );

    assert.equal(result.success, false);
    assert.equal(result.error?.code, "service_error");
});
