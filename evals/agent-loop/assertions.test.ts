import assert from "node:assert/strict";
import test from "node:test";
import type { TraceEvent } from "@dkagent/trace";
import { gradeAgentRun } from "./assertions.js";
import {
  findUnpairedToolCallIds,
  findToolProtocolViolations,
  hasNormalTermination,
  selectToolCalls,
  selectToolResults,
} from "./trace-selectors.js";

function event(
  sequence: number,
  name: TraceEvent["name"],
  phase: TraceEvent["phase"],
  data: unknown,
): TraceEvent {
  return {
    id: `event-${sequence}`,
    traceId: "trace-1",
    spanId: `span-${sequence}`,
    sequence,
    timestamp: "2026-08-26T00:00:00.000Z",
    name,
    phase,
    step: 1,
    data,
  };
}

const completeReadTrace: TraceEvent[] = [
  event(1, "agent.turn", "start", { input: "读取 notes.txt" }),
  event(2, "tool.call", "start", {
    input: { id: "call-1", name: "read_file", input: { path: "notes.txt" } },
  }),
  event(3, "tool.result", "event", {
    toolCallId: "call-1",
    name: "read_file",
    input: { path: "notes.txt" },
    result: { success: true, data: { content: "DKAGENT_EVAL_7319" } },
  }),
  event(4, "tool.call", "end", {
    output: { toolCallId: "call-1", name: "read_file" },
  }),
  event(5, "agent.turn", "end", { output: { answer: "DKAGENT_EVAL_7319" } }),
];

const normalTurnTrace: TraceEvent[] = [
  event(1, "agent.turn", "start", { input: "READY" }),
  event(2, "agent.turn", "end", { output: { answer: "READY" } }),
];

function completeToolTrace(
  name: string,
  input: Record<string, unknown>,
  resultData: unknown,
): TraceEvent[] {
  const toolCallId = `call-${name}`;
  return [
    event(1, "agent.turn", "start", { input: "执行文件查询" }),
    event(2, "tool.call", "start", {
      input: { id: toolCallId, name, input },
    }),
    event(3, "tool.result", "event", {
      toolCallId,
      name,
      input,
      result: { success: true, data: resultData },
    }),
    event(4, "tool.call", "end", {
      output: { toolCallId, name },
    }),
    event(5, "agent.turn", "end", { output: { answer: "查询完成" } }),
  ];
}

function completeSequenceTrace(
  tools: Array<{
    name: string;
    input: Record<string, unknown>;
    resultData: unknown;
  }>,
): TraceEvent[] {
  const trace: TraceEvent[] = [];
  let sequence = 1;
  trace.push(event(sequence, "agent.turn", "start", { input: "执行多步文件操作" }));
  sequence += 1;
  tools.forEach((tool, index) => {
    const toolCallId = `call-sequence-${index + 1}`;
    trace.push(event(sequence, "tool.call", "start", {
      input: { id: toolCallId, name: tool.name, input: tool.input },
    }));
    sequence += 1;
    trace.push(event(sequence, "tool.result", "event", {
      toolCallId,
      name: tool.name,
      input: tool.input,
      result: { success: true, data: tool.resultData },
    }));
    sequence += 1;
    trace.push(event(sequence, "tool.call", "end", {
      output: { toolCallId, name: tool.name },
    }));
    sequence += 1;
  });
  trace.push(event(sequence, "agent.turn", "end", { output: { answer: "result.txt 已创建" } }));
  return trace;
}

const writeEvaluationContent = "DKAgent write evaluation payload\nline two remains unchanged\n";
const readThenWriteWorkspace = "/private/tmp/dkagent-agent-eval-123/workspace";
const completeReadThenWriteTrace = completeSequenceTrace([
  {
    name: "read_file",
    input: { path: "source.txt" },
    resultData: { content: writeEvaluationContent },
  },
  {
    name: "write_file",
    input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
    resultData: {
      path: `${readThenWriteWorkspace}/result.txt`,
      bytesWritten: Buffer.byteLength(writeEvaluationContent, "utf8"),
      overwritten: false,
    },
  },
]);

test("selectors only count tool.call start and tool.result event", () => {
  assert.deepEqual(selectToolCalls(completeReadTrace), [{
    id: "call-1",
    name: "read_file",
    input: { path: "notes.txt" },
    sequence: 2,
    step: 1,
  }]);
  assert.deepEqual(selectToolResults(completeReadTrace), [{
    toolCallId: "call-1",
    name: "read_file",
    input: { path: "notes.txt" },
    result: { success: true, data: { content: "DKAGENT_EVAL_7319" } },
    sequence: 3,
    step: 1,
  }]);
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace), []);
  assert.deepEqual(findToolProtocolViolations(completeReadTrace), []);
  assert.equal(hasNormalTermination(completeReadTrace), true);
});

test("grader reports required tool, pairing, result, output, and termination", () => {
  const result = gradeAgentRun("验证码是 DKAGENT_EVAL_7319", {
    vars: {},
    test: {} as never,
    providerResponse: {
      output: "验证码是 DKAGENT_EVAL_7319",
      metadata: { evalRun: { caseId: "read-file", traceEvents: completeReadTrace } },
    },
    config: {
      requiredTools: ["read_file"],
      outputIncludes: "DKAGENT_EVAL_7319",
    },
  } as never);

  assert.equal(result.pass, true);
  assert.equal(result.componentResults?.length, 6);
  assert.deepEqual(result.componentResults?.map((component) => component.metadata?.component), [
    "runError",
    "requiredTool",
    "requiredToolResult",
    "protocolIntegrity",
    "outputIncludes",
    "termination",
  ]);
  assert.equal(result.componentResults?.every((component) => component.pass), true);
});

test("grader identifies an unpaired call", () => {
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace.slice(0, 2)), ["call-1"]);
});

function gradeWithTrace(
  traceEvents: TraceEvent[],
  config: Record<string, unknown> = {
    requiredTools: ["read_file"],
    outputIncludes: "DKAGENT_EVAL_7319",
  },
  output = "验证码是 DKAGENT_EVAL_7319",
  workspaceRoot?: string,
  finalFiles?: Record<string, string>,
) {
  return gradeAgentRun(output, {
    vars: {},
    test: {} as never,
    providerResponse: {
      output,
      metadata: {
        evalRun: {
          caseId: "read-file",
          traceEvents,
          ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
          ...(finalFiles === undefined ? {} : { finalFiles }),
        },
      },
    },
    config,
  } as never);
}

test("grader fails the runError component", () => {
  const trace = completeReadTrace;
  const result = gradeWithTrace(trace);
  const metadata = (result.componentResults ?? []);
  assert.equal(metadata.find((component) => component.metadata?.component === "runError")?.pass, true);
  const withError = gradeAgentRun("验证码是 DKAGENT_EVAL_7319", {
    vars: {},
    test: {} as never,
    providerResponse: {
      output: "验证码是 DKAGENT_EVAL_7319",
      metadata: {
        evalRun: {
          caseId: "read-file",
          traceEvents: trace,
          runError: { stage: "agent", message: "agent failed" },
        },
      },
    },
    config: { requiredTools: ["read_file"], outputIncludes: "DKAGENT_EVAL_7319" },
  } as never);
  assert.equal(withError.componentResults?.find((component) => component.metadata?.component === "runError")?.pass, false);
});

test("grader fails when a required Tool is missing", () => {
  const result = gradeWithTrace(completeReadTrace, {
    requiredTools: ["grep_files"],
    outputIncludes: "DKAGENT_EVAL_7319",
  });
  assert.equal(result.componentResults?.find((component) => component.metadata?.component === "requiredTool")?.pass, false);
});

test("grader fails when a required Tool Result is unsuccessful", () => {
  const failedResultTrace = completeReadTrace.map((traceEvent) => (
    traceEvent.name === "tool.result"
      ? { ...traceEvent, data: {
        ...(traceEvent.data as Record<string, unknown>),
        result: { success: false, error: { code: "EIO", message: "read failed" } },
      } }
      : traceEvent
  ));
  const result = gradeWithTrace(failedResultTrace);
  assert.equal(result.componentResults?.find((component) => component.metadata?.component === "requiredToolResult")?.pass, false);
});

test("grader fails protocol integrity for an unpaired call", () => {
  const result = gradeWithTrace(completeReadTrace.slice(0, 2));
  assert.equal(result.componentResults?.find((component) => component.metadata?.component === "protocolIntegrity")?.pass, false);
  assert.match(result.componentResults?.find((component) => component.metadata?.component === "protocolIntegrity")?.reason ?? "", /call-1/);
});

test("grader fails when outputIncludes is missing", () => {
  const result = gradeWithTrace(completeReadTrace, {
    requiredTools: ["read_file"],
    outputIncludes: "MISSING_MARKER",
  });
  assert.equal(result.componentResults?.find((component) => component.metadata?.component === "outputIncludes")?.pass, false);
});

test("grader fails abnormal termination", () => {
  const abnormalTrace = completeReadTrace.filter((traceEvent) => traceEvent.name !== "agent.turn" || traceEvent.phase !== "end");
  const result = gradeWithTrace(abnormalTrace);
  assert.equal(result.componentResults?.find((component) => component.metadata?.component === "termination")?.pass, false);
});

test("selectors discard malformed and wrong-phase events", () => {
  const malformed: TraceEvent[] = [
    event(10, "tool.call", "end", {
      input: { id: "wrong-phase", name: "read_file", input: { path: "bad" } },
    }),
    event(11, "tool.result", "start", {
      toolCallId: "wrong-phase", name: "read_file", input: { path: "bad" }, result: { success: true },
    }),
    event(12, "tool.call", "start", { input: { id: "missing-input", name: "read_file" } }),
    event(13, "tool.call", "start", { input: "not-a-call" }),
    event(14, "tool.result", "event", { toolCallId: "missing-result", name: "read_file", input: { path: "bad" } }),
    event(15, "tool.result", "event", {
      toolCallId: "bad-success", name: "read_file", input: { path: "bad" }, result: { success: "yes" },
    }),
  ];
  assert.deepEqual(selectToolCalls(malformed), []);
  assert.deepEqual(selectToolResults(malformed), []);
});

test("protocol integrity is bidirectional one-to-one with diagnostics", () => {
  const invalidTrace: TraceEvent[] = [
    event(20, "tool.call", "start", { input: { id: "duplicate-call", name: "read_file", input: { path: "a" } } }),
    event(21, "tool.call", "start", { input: { id: "duplicate-call", name: "read_file", input: { path: "b" } } }),
    event(22, "tool.result", "event", {
      toolCallId: "duplicate-call", name: "read_file", input: { path: "a" }, result: { success: true },
    }),
    event(23, "tool.result", "event", {
      toolCallId: "duplicate-call", name: "read_file", input: { path: "b" }, result: { success: true },
    }),
    event(24, "tool.result", "event", {
      toolCallId: "orphan-result", name: "grep_files", input: { path: "x" }, result: { success: true },
    }),
    event(25, "tool.call", "start", { input: { id: "name-mismatch", name: "read_file", input: { path: "x" } } }),
    event(26, "tool.result", "event", {
      toolCallId: "name-mismatch", name: "write_file", input: { path: "x" }, result: { success: true },
    }),
  ];
  const violations = findToolProtocolViolations(invalidTrace);
  assert.equal(violations.length, 4);
  assert.deepEqual(violations.map((violation) => violation.kind), [
    "duplicate-call-id",
    "duplicate-result-id",
    "orphan-result",
    "tool-name-mismatch",
  ]);
  assert.match(violations.map((violation) => violation.message).join(" "), /duplicate-call/);
  assert.match(violations.map((violation) => violation.message).join(" "), /orphan-result/);
  assert.match(violations.map((violation) => violation.message).join(" "), /name-mismatch/);
});

test("grader enforces requireNoTools", () => {
  const direct = gradeWithTrace(normalTurnTrace, {
    requireNoTools: true,
    outputIncludes: "READY",
  }, "READY");
  assert.equal(direct.pass, true);

  const withTool = gradeWithTrace(completeReadTrace, {
    requireNoTools: true,
  });
  assert.equal(withTool.pass, false);
});

test("grader rejects a forbidden Tool", () => {
  const result = gradeWithTrace(completeReadTrace, {
    forbiddenTools: ["read_file"],
  });
  assert.equal(result.pass, false);
});

test("grader enforces the exact find_files result set", () => {
  const workspaceRoot = "/private/tmp/dkagent-agent-eval-123/workspace";
  const expected = {
    requiredTools: ["find_files"],
    expectedFindFiles: ["src/a.ts", "src/b.ts"],
  };
  const exact = gradeWithTrace(completeToolTrace(
    "find_files",
    { path: "src", pattern: "**/*.ts" },
    {
      path: `${workspaceRoot}/src`,
      files: ["b.ts", "a.ts"],
      total: 2,
    },
  ), expected, "", workspaceRoot);
  assert.equal(exact.pass, true);

  const withReadme = gradeWithTrace(completeToolTrace(
    "find_files",
    { path: "src", pattern: "**/*" },
    { path: workspaceRoot, files: ["src/a.ts", "src/b.ts", "README.md"], total: 3 },
  ), expected, "", workspaceRoot);
  assert.equal(withReadme.pass, false);

  const withDuplicate = gradeWithTrace(completeToolTrace(
    "find_files",
    { path: "src", pattern: "**/*.ts" },
    { path: `${workspaceRoot}/src`, files: ["a.ts", "a.ts"], total: 2 },
  ), expected, "", workspaceRoot);
  assert.equal(withDuplicate.pass, false);

  for (const path of ["../../workspace/src", "/outside/workspace/src"]) {
    const outside = gradeWithTrace(completeToolTrace(
      "find_files",
      { path: "src", pattern: "**/*.ts" },
      { path, files: ["a.ts", "b.ts"], total: 2 },
    ), expected, "", workspaceRoot);
    assert.equal(outside.pass, false, `越界 find_files path 不应通过: ${path}`);
  }

  const missingPath = gradeWithTrace(completeToolTrace(
    "find_files",
    { path: "src", pattern: "**/*.ts" },
    { files: ["src/a.ts", "src/b.ts"], total: 2 },
  ), expected, "", workspaceRoot);
  assert.equal(missingPath.pass, false);
});

test("grader requires a matching grep_files result", () => {
  const workspaceRoot = "/private/tmp/dkagent-agent-eval-123/workspace";
  const expected = {
    requiredTools: ["grep_files"],
    expectedGrep: { path: "hit.txt", text: "DKAGENT_GREP_4821" },
  };
  const match = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      path: workspaceRoot,
      matches: [{ path: "hit.txt", line: 1, text: "search marker: DKAGENT_GREP_4821" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(match.pass, true);

  const miss = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      path: workspaceRoot,
      matches: [{ path: "miss.txt", line: 1, text: "this file has no target marker" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(miss.pass, false);

  const wrongPath = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      path: workspaceRoot,
      matches: [{ path: "not-hit.txt", line: 1, text: "DKAGENT_GREP_4821" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(wrongPath.pass, false);

  const malformed = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      path: workspaceRoot,
      matches: [{ path: "hit.txt", line: 0, text: "DKAGENT_GREP_4821" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(malformed.pass, false);

  const outside = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      path: "/outside/workspace",
      matches: [{ path: "hit.txt", line: 1, text: "DKAGENT_GREP_4821" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(outside.pass, false);

  const missingPath = gradeWithTrace(completeToolTrace(
    "grep_files",
    { pattern: "DKAGENT_GREP_4821" },
    {
      matches: [{ path: "hit.txt", line: 1, text: "DKAGENT_GREP_4821" }],
      total: 1,
    },
  ), expected, "", workspaceRoot);
  assert.equal(missingPath.pass, false);
});

test("grader enforces causal Tool order by Trace sequence and input path", () => {
  const config = {
    requiredTools: ["read_file", "write_file"],
    mustHappenBefore: {
      before: { tool: "read_file", path: "source.txt" },
      after: { tool: "write_file", path: "result.txt" },
    },
  };
  const readThenWriteThenVerify = completeSequenceTrace([
    { name: "read_file", input: { path: "source.txt" }, resultData: { content: writeEvaluationContent } },
    {
      name: "write_file",
      input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
    { name: "read_file", input: { path: "result.txt" }, resultData: { content: writeEvaluationContent } },
  ]);
  const valid = gradeWithTrace(readThenWriteThenVerify, config, "", readThenWriteWorkspace);
  assert.equal(valid.pass, true);
  assert.equal(
    valid.componentResults?.find((item) => item.metadata?.component === "mustHappenBefore")?.pass,
    true,
  );

  const writeThenRead = gradeWithTrace(completeSequenceTrace([
    {
      name: "write_file",
      input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
    { name: "read_file", input: { path: "source.txt" }, resultData: { content: writeEvaluationContent } },
  ]), config, "", readThenWriteWorkspace);
  assert.equal(writeThenRead.pass, false);
  assert.equal(
    writeThenRead.componentResults?.find((item) => item.metadata?.component === "mustHappenBefore")?.pass,
    false,
  );

  const wrongReadPath = gradeWithTrace(completeSequenceTrace([
    { name: "read_file", input: { path: "other.txt" }, resultData: { content: writeEvaluationContent } },
    {
      name: "write_file",
      input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
  ]), config, "", readThenWriteWorkspace);
  assert.equal(wrongReadPath.pass, false);
  assert.equal(
    wrongReadPath.componentResults?.find((item) => item.metadata?.component === "mustHappenBefore")?.pass,
    false,
  );

  const wrongWritePath = gradeWithTrace(completeSequenceTrace([
    { name: "read_file", input: { path: "source.txt" }, resultData: { content: writeEvaluationContent } },
    {
      name: "write_file",
      input: { path: "other.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/other.txt` },
    },
  ]), config, "", readThenWriteWorkspace);
  assert.equal(wrongWritePath.pass, false);
  assert.equal(
    wrongWritePath.componentResults?.find((item) => item.metadata?.component === "mustHappenBefore")?.pass,
    false,
  );

  const absoluteReadThenWrite = gradeWithTrace(completeSequenceTrace([
    {
      name: "read_file",
      input: { path: `${readThenWriteWorkspace}/source.txt` },
      resultData: { content: writeEvaluationContent },
    },
    {
      name: "write_file",
      input: {
        path: `${readThenWriteWorkspace}/result.txt`,
        content: writeEvaluationContent,
        overwrite: false,
      },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
  ]), config, "", readThenWriteWorkspace);
  assert.equal(absoluteReadThenWrite.pass, true);

  const sourceReadFailedButLaterReadSucceeded = completeSequenceTrace([
    { name: "read_file", input: { path: "source.txt" }, resultData: { content: writeEvaluationContent } },
    {
      name: "write_file",
      input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
    { name: "read_file", input: { path: "result.txt" }, resultData: { content: writeEvaluationContent } },
  ]).map((traceEvent) => (
    traceEvent.name === "tool.result"
      && (traceEvent.data as Record<string, unknown>).input
      && ((traceEvent.data as { input: { path?: unknown } }).input.path === "source.txt")
      ? {
        ...traceEvent,
        data: {
          ...(traceEvent.data as Record<string, unknown>),
          result: { success: false, error: { code: "ENOENT", message: "source missing" } },
        },
      }
      : traceEvent
  ));
  const failedSourceRead = gradeWithTrace(
    sourceReadFailedButLaterReadSucceeded,
    config,
    "",
    readThenWriteWorkspace,
  );
  assert.equal(failedSourceRead.pass, false);
  assert.equal(
    failedSourceRead.componentResults?.find((item) => item.metadata?.component === "mustHappenBefore")?.pass,
    false,
  );

  const outsideRead = gradeWithTrace(completeSequenceTrace([
    {
      name: "read_file",
      input: { path: "/outside/workspace/source.txt" },
      resultData: { content: writeEvaluationContent },
    },
    {
      name: "write_file",
      input: { path: "result.txt", content: writeEvaluationContent, overwrite: false },
      resultData: { path: `${readThenWriteWorkspace}/result.txt` },
    },
  ]), config, "", readThenWriteWorkspace);
  assert.equal(outsideRead.pass, false);
});

test("grader requires the expected read_file Call and Result to target workspaceRoot/notes.txt", () => {
  const workspaceRoot = "/private/tmp/dkagent-agent-eval-123/workspace";
  const config = {
    requiredTools: ["read_file"],
    expectedToolPaths: { read_file: "notes.txt" },
  };
  const valid = gradeWithTrace(completeReadTrace, config, "", workspaceRoot);
  assert.equal(valid.componentResults?.find((item) => item.metadata?.component === "expectedToolPaths")?.pass, true);

  const outside = completeReadTrace.map((traceEvent) => {
    if (traceEvent.name === "tool.call") {
      return {
        ...traceEvent,
        data: {
          input: {
            id: "call-1",
            name: "read_file",
            input: { path: "/outside/workspace/notes.txt" },
          },
        },
      };
    }
    if (traceEvent.name === "tool.result") {
      return {
        ...traceEvent,
        data: {
          ...(traceEvent.data as Record<string, unknown>),
          input: { path: "/outside/workspace/notes.txt" },
        },
      };
    }
    return traceEvent;
  });
  const rejected = gradeWithTrace(outside, config, "", workspaceRoot);
  assert.equal(rejected.componentResults?.find((item) => item.metadata?.component === "expectedToolPaths")?.pass, false);

  const mismatchedResult = completeReadTrace.map((traceEvent) => (
    traceEvent.name === "tool.result"
      ? {
        ...traceEvent,
        data: {
          ...(traceEvent.data as Record<string, unknown>),
          input: { path: "other.txt" },
        },
      }
      : traceEvent
  ));
  const mismatch = gradeWithTrace(mismatchedResult, config, "", workspaceRoot);
  assert.equal(mismatch.componentResults?.find((item) => item.metadata?.component === "expectedToolPaths")?.pass, false);
});

test("grader requires exact final-file contents and names missing files", () => {
  const config = {
    requiredTools: ["read_file", "write_file"],
    expectedFinalFiles: { "result.txt": writeEvaluationContent },
  };
  const exact = gradeWithTrace(
    completeReadThenWriteTrace,
    config,
    "",
    readThenWriteWorkspace,
    { "result.txt": writeEvaluationContent },
  );
  assert.equal(exact.pass, true);

  const wrongContent = gradeWithTrace(
    completeReadThenWriteTrace,
    config,
    "",
    readThenWriteWorkspace,
    { "result.txt": `${writeEvaluationContent}extra` },
  );
  assert.equal(wrongContent.pass, false);
  assert.equal(
    wrongContent.componentResults?.find((item) => item.metadata?.component === "expectedFinalFiles")?.pass,
    false,
  );

  const missing = gradeWithTrace(
    completeReadThenWriteTrace,
    config,
    "",
    readThenWriteWorkspace,
    {},
  );
  const missingComponent = missing.componentResults?.find(
    (item) => item.metadata?.component === "expectedFinalFiles",
  );
  assert.equal(missing.pass, false);
  assert.equal(missingComponent?.pass, false);
  assert.match(missingComponent?.reason ?? "", /result\.txt/);
});
