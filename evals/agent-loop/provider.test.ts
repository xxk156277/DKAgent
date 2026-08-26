import assert from "node:assert/strict";
import test from "node:test";
import { isAbsolute } from "node:path";
import type {
  AgentMessage,
  LLMProvider,
  ModelRequest,
  StreamEvent,
  ToolSchema,
} from "../../packages/agent/src/query-engine/provider.js";
import type { AgentEvalRunMetadata } from "./assertions.js";
import { setCleanupForTest } from "./internal/cleanup.js";
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
  assert.equal(isAbsolute(metadata.workspaceRoot ?? ""), true);
  assert.match(metadata.workspaceRoot ?? "", /[\\/]workspace$/);
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

const readThenWriteContent = "DKAgent write evaluation payload\nline two remains unchanged\n";

class ReadThenWriteFakeProvider implements LLMProvider {
  public readonly name = "read-then-write-fake";
  public readonly requests: ModelRequest[] = [];
  public secondRequestReadResult: string | undefined;
  private requestCount = 0;

  public async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    this.requestCount += 1;
    if (this.requestCount === 1) {
      yield { type: "tool_call_start", index: 0, id: "call-read", name: "read_file" };
      yield { type: "tool_call_delta", index: 0, argumentsDelta: '{"path":"source.txt"}' };
      yield { type: "tool_call_end", index: 0 };
      yield {
        type: "message_end",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
      return;
    }

    if (this.requestCount === 2) {
      const readResultMessage = request.messages.find(
        (message) => message.role === "tool" && message.toolCallId === "call-read",
      );
      if (!readResultMessage || readResultMessage.role !== "tool") {
        throw new Error("第二轮请求缺少 read_file Result");
      }
      const readResult = JSON.parse(readResultMessage.content) as {
        success?: unknown;
        data?: { content?: unknown };
      };
      if (readResult.success !== true || readResult.data?.content !== readThenWriteContent) {
        throw new Error("第二轮请求未携带完整 read_file Result");
      }
      this.secondRequestReadResult = readResult.data.content;
      yield { type: "tool_call_start", index: 0, id: "call-write", name: "write_file" };
      yield {
        type: "tool_call_delta",
        index: 0,
        argumentsDelta: JSON.stringify({
          path: "result.txt",
          content: readThenWriteContent,
          overwrite: false,
        }),
      };
      yield { type: "tool_call_end", index: 0 };
      yield {
        type: "message_end",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "tool_use",
      };
      return;
    }

    if (this.requestCount === 3) {
      yield { type: "text_delta", content: "result.txt 已创建" };
      yield {
        type: "message_end",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
      return;
    }

    throw new Error("Fake Provider 收到超出三轮的请求");
  }

  public async countTokens(
    _messages: AgentMessage[],
    _tools?: ToolSchema[],
  ): Promise<number> {
    return 1;
  }
}

test("runAgentEvalCase verifies read_file Result before writing and captures the final file", async () => {
  const provider = new ReadThenWriteFakeProvider();
  const response = await runAgentEvalCase({
    caseId: "read-then-write",
    prompt: "请读取 source.txt 的完整内容，将内容原样写入新的 result.txt，不要修改 source.txt。",
    enabledTools: ["read_file", "write_file"],
    captureFiles: ["result.txt"],
    provider,
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
  });

  assert.equal(response.output, "result.txt 已创建");
  const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
  assert.equal(metadata.runError, undefined);
  assert.equal(provider.secondRequestReadResult, readThenWriteContent);
  assert.deepEqual(provider.requests[0]?.tools?.map((tool) => tool.name), ["read_file", "write_file"]);
  assert.deepEqual(selectToolCalls(metadata.traceEvents).map((call) => call.name), ["read_file", "write_file"]);
  assert.deepEqual(findUnpairedToolCallIds(metadata.traceEvents), []);
  const results = selectToolResults(metadata.traceEvents);
  assert.deepEqual(results.map((result) => result.name), ["read_file", "write_file"]);
  assert.equal(results.every((result) => result.result.success), true);
  const writeCall = selectToolCalls(metadata.traceEvents).find((call) => call.name === "write_file");
  assert.deepEqual(writeCall?.input, {
    path: "result.txt",
    content: readThenWriteContent,
    overwrite: false,
  });
  const writeResult = results.find((result) => result.name === "write_file");
  assert.equal(writeResult?.result.success, true);
  assert.deepEqual(metadata.finalFiles, { "result.txt": readThenWriteContent });
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

test("metadata key collisions fail closed without returning metadata", async () => {
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt。",
    enabledTools: ["read_file"],
    provider: new ModelFailureFakeProvider(),
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
    secrets: ["runError"],
  });

  assert.equal(response.metadata, undefined);
  assert.match(response.error ?? "", /安全|配置/);
});

test("TraceEvent key collisions fail closed without returning metadata", async () => {
  const response = await runAgentEvalCase({
    caseId: "read-file",
    prompt: "请读取 notes.txt，并告诉我其中的验证码。",
    enabledTools: ["read_file"],
    provider: new ReadFileFakeProvider(),
    model: "fake-model",
    maxContextTokens: 1_000,
    maxOutputTokens: 100,
    secrets: ["timestamp"],
  });

  assert.equal(response.metadata, undefined);
  assert.match(response.error ?? "", /安全|配置/);
});

test("TraceEvent required field values fail closed without changing their structure", () => {
  const secret = "timestamp-secret-7319";
  const event: TraceEvent = {
    id: "event-1",
    traceId: "trace-1",
    sequence: 1,
    timestamp: `2026-08-26T00:00:00.000Z-${secret}`,
    name: "agent.turn",
    phase: "start",
    data: {},
  };

  assert.throws(
    () => redactMetadata([event], [secret]),
    /安全|配置/,
  );
});

test("TraceEvent structural values fail closed without heuristic secret filtering", async () => {
  for (const secret of ["tool", "tool.call"]) {
    const provider = new ReadFileFakeProvider();
    const response = await runAgentEvalCase({
      caseId: "read-file",
      prompt: "请读取 notes.txt，并告诉我其中的验证码。",
      enabledTools: ["read_file"],
      provider,
      model: "fake-model",
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      secrets: [secret],
    });

    assert.equal(response.metadata, undefined);
    assert.doesNotMatch(JSON.stringify(response), new RegExp(secret.replace(".", "\\.")));
    assert.match(response.error ?? "", /安全|配置/i);
  }
});

test("payload secrets are redacted exactly regardless of their shape", () => {
  const secret = "a_b";
  const redacted = redactMetadata({
    payload: {
      [`field-${secret}`]: `value-${secret}`,
    },
  }, [secret]) as { payload: Record<string, string> };

  assert.deepEqual(redacted.payload, {
    "field-[REDACTED]": "value-[REDACTED]",
  });
});

test("workspaceRoot secret collisions fail closed before metadata is returned", () => {
  const metadata: AgentEvalRunMetadata = {
    caseId: "read-file",
    workspaceRoot: "/tmp/workspace-secret-7319/workspace",
    traceEvents: [],
  };

  assert.throws(
    () => redactMetadata(metadata, ["workspace-secret-7319"]),
    /安全|配置/,
  );
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

test("selector identity collisions fail closed even when both sides are redacted", () => {
  const secret = "call-id-secret-7319";
  const callEvent: TraceEvent = {
    id: "event-call",
    traceId: "trace-1",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
    name: "tool.call",
    phase: "start",
    data: {
      input: {
        id: secret,
        name: "read_file",
        input: { path: "notes.txt" },
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
      toolCallId: secret,
      name: "read_file",
      input: { path: "notes.txt" },
      result: { success: true, data: { content: "ok" } },
    },
  };

  assert.throws(
    () => redactMetadata([callEvent, resultEvent], [secret]),
    /安全|配置/,
  );
});

test("cleanup error takes precedence over a prior model error", async () => {
  setCleanupForTest(async () => {
    throw new Error("cleanup contains secret SHOULD NOT LEAK");
  });
  try {
    const response = await runAgentEvalCase({
      caseId: "read-file",
      prompt: "请读取 notes.txt。",
      enabledTools: ["read_file"],
      provider: new ModelFailureFakeProvider(),
      model: "fake-model",
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
    });

    const metadata = response.metadata?.evalRun as AgentEvalRunMetadata;
    assert.equal(metadata.runError?.stage, "cleanup");
    assert.match(metadata.runError?.message ?? "", /清理|cleanup/i);
    assert.doesNotMatch(metadata.runError?.message ?? "", /SHOULD NOT LEAK|model exploded/);
  } finally {
    setCleanupForTest(undefined);
  }
});
