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
) {
  return gradeAgentRun(output, {
    vars: {},
    test: {} as never,
    providerResponse: {
      output,
      metadata: { evalRun: { caseId: "read-file", traceEvents } },
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
