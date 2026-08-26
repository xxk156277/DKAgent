import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentMessage,
  LLMProvider,
  ModelRequest,
  StreamEvent,
  ToolSchema,
} from "../../packages/agent/src/query-engine/provider.js";
import type { AgentEvalRunMetadata } from "./assertions.js";
import { runAgentEvalCase } from "./provider.js";
import {
  findUnpairedToolCallIds,
  selectToolCalls,
} from "./trace-selectors.js";

class ReadFileFakeProvider implements LLMProvider {
  public readonly name = "read-file-fake";
  private requestCount = 0;

  public async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      yield { type: "tool_call_start", index: 0, id: "call-read", name: "read_file" };
      yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"notes.txt"}' };
      yield { type: "tool_call_end", index: 0 };
      yield {
        type: "message_end",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
      return;
    }

    yield { type: "text_delta", content: "验证码是 DKAGENT_EVAL_7319" };
    yield {
      type: "message_end",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }

  public async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 1;
  }
}

test("runAgentEvalCase executes read_file through the production AgentLoop", async () => {
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt，并告诉我其中的验证码。",
    enabledTools: ["read_file"],
    provider: new ReadFileFakeProvider(),
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
  });

  assert.equal(response.output, "验证码是 DKAGENT_EVAL_7319");
  const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
  assert.equal(metadata.caseId, "read-file");
  assert.equal(metadata.runError, undefined);
  assert.deepEqual(
    selectToolCalls(metadata.traceEvents).map((call) => call.name),
    ["read_file"],
  );
  assert.deepEqual(findUnpairedToolCallIds(metadata.traceEvents), []);
});
