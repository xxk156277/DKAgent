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
import { redactMetadata, runAgentEvalCase } from "./provider.js";
import {
  findUnpairedToolCallIds,
  selectToolCalls,
  selectToolResults,
} from "./trace-selectors.js";
import type { TraceEvent } from "@dkagent/trace";

class ReadFileFakeProvider implements LLMProvider {
  public readonly name = "read-file-fake";
  public readonly requests: ModelRequest[] = [];
  private requestCount = 0;

  public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
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
  const provider = new ReadFileFakeProvider();
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt，并告诉我其中的验证码。",
    enabledTools: ["read_file"],
    provider,
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
  assert.deepEqual(provider.requests[0]?.tools?.map((tool) => tool.name), ["read_file"]);
  assert.equal(provider.requests[0]?.tools?.length, 1);
  const toolMessage = provider.requests[1]?.messages.find((message) => message.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  const toolResult = JSON.parse(toolMessage.content) as {
    success: boolean;
    data?: { content?: string };
  };
  assert.equal(toolResult.success, true);
  assert.match(toolResult.data?.content ?? "", /DKAGENT_EVAL_7319/);

  const [readResult] = selectToolResults(metadata.traceEvents);
  assert.equal(readResult?.name, "read_file");
  assert.equal(readResult?.result.success, true);
  assert.match(
    String((readResult?.result.data as { content?: string } | undefined)?.content),
    /DKAGENT_EVAL_7319/,
  );
});

class ModelFailureFakeProvider implements LLMProvider {
  public readonly name = "model-failure-fake";

  public async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
    throw new Error("model exploded");
  }

  public async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 1;
  }
}

test("missing capture does not replace an existing model error", async () => {
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt。",
    enabledTools: ["read_file"],
    captureFiles: ["result.txt"],
    provider: new ModelFailureFakeProvider(),
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
  });

  const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
  assert.equal(metadata.runError?.stage, "model");
  assert.match(metadata.runError?.message ?? "", /model exploded/);
});

test("missing capture is kept absent without creating a Provider error", async () => {
  const provider = new ReadFileFakeProvider();
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt，并告诉我其中的验证码。",
    enabledTools: ["read_file"],
    captureFiles: ["result.txt"],
    provider,
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
  });

  const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
  assert.equal(metadata.runError, undefined);
  assert.deepEqual(metadata.finalFiles, {});
});

test("non-missing capture failures retain the capture stage", async () => {
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt，并告诉我其中的验证码。",
    enabledTools: ["read_file"],
    captureFiles: ["notes.txt/child"],
    provider: new ReadFileFakeProvider(),
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
  });

  const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
  assert.equal(metadata.runError?.stage, "capture");
  assert.match(metadata.runError?.message ?? "", /ENOTDIR|not a directory/i);
});

test("redactMetadata removes exact secrets from nested keys and values without breaking Trace selectors", () => {
  const secret = "EVAL_SECRET_7319";
  const callEvent: TraceEvent = {
    id: "event-call",
    traceId: "trace-1",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
    name: "tool.call",
    phase: "start",
    data: {
      input: {
        id: "call-1",
        name: "read_file",
        input: {
          path: "notes.txt",
          [`payload-${secret}`]: `value-${secret}`,
        },
      },
    },
  };
  const resultEvent: TraceEvent = {
    id: "event-result",
    traceId: "trace-1",
    sequence: 2,
    timestamp: "2026-08-26T00:00:00.000Z",
    name: "tool.result",
    phase: "event",
    data: {
      toolCallId: "call-1",
      name: "read_file",
      input: { path: "notes.txt" },
      result: {
        success: true,
        data: { content: `fixture-${secret}` },
      },
    },
  };

  const redacted = redactMetadata({
    [`outer-${secret}`]: { [`nested-${secret}`]: `value-${secret}` },
    events: [callEvent, resultEvent],
  }, [secret]) as { events: TraceEvent[] };

  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(secret));
  assert.equal(redacted.events[0]?.name, "tool.call");
  assert.equal(redacted.events[0]?.phase, "start");
  assert.equal(redacted.events[1]?.name, "tool.result");
  assert.equal(redacted.events[1]?.phase, "event");
  assert.deepEqual(selectToolCalls(redacted.events).map((call) => call.name), ["read_file"]);
  const [result] = selectToolResults(redacted.events);
  assert.equal(result?.result.success, true);
  assert.match(String((result?.result.data as { content?: string } | undefined)?.content), /REDACTED/);
});

test("empty and structural short secrets do not corrupt Trace discriminants", () => {
  const event: TraceEvent = {
    id: "event-structure",
    traceId: "trace-structure",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
    name: "tool.call",
    phase: "start",
    data: {
      input: {
        id: "call-structure",
        name: "read_file",
        input: { path: "notes.txt" },
      },
    },
  };

  const redacted = redactMetadata({ event }, ["", "tool"]) as { event: TraceEvent };
  assert.equal(redacted.event.name, "tool.call");
  assert.equal(redacted.event.phase, "start");
  assert.deepEqual(selectToolCalls([redacted.event]).map((call) => call.name), ["read_file"]);
});
