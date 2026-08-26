import assert from "node:assert/strict";
import test from "node:test";
import type { TraceEvent } from "@dkagent/trace";
import { gradeAgentRun } from "./assertions.js";
import {
  findUnpairedToolCallIds,
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
  assert.deepEqual(selectToolCalls(completeReadTrace).map((call) => call.name), ["read_file"]);
  assert.equal(selectToolResults(completeReadTrace).length, 1);
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace), []);
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
  assert.equal(result.componentResults?.every((component) => component.pass), true);
});

test("grader identifies an unpaired call", () => {
  assert.deepEqual(findUnpairedToolCallIds(completeReadTrace.slice(0, 2)), ["call-1"]);
});
