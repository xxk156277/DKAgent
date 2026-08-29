import type {
    AnyTraceSpan,
    SpanKindMap,
    TraceSpan,
    TraceSpanHandle,
    SpanOutputMap,
} from "./types.js";

declare const span: AnyTraceSpan;
if (span.name === "model.generate") {
    span.kind satisfies SpanKindMap["model.generate"];
    span.input.provider satisfies string;
    if (span.output?.type === "text") span.output.content satisfies string;
}
if (span.name === "tool.execute") {
    span.kind satisfies SpanKindMap["tool.execute"];
    span.input.name satisfies string;
    span.output?.success satisfies boolean | undefined;
}

declare const tracer: import("./tracer.js").Tracer;
// @ts-expect-error trace roots are restricted to agent.turn.
tracer.trace("model.generate", { provider: "x", model: "x", messages: [] }, async () => undefined);
// @ts-expect-error span cannot create an agent.turn root.
tracer.span("agent.turn", { userInput: "x" }, async () => undefined);
// @ts-expect-error spanSync does not accept an async callback.
tracer.spanSync("tool.execute", { toolCallId: "x", name: "x", input: {} }, async () => undefined);

// @ts-expect-error kind must match the discriminated span name.
const mismatched: TraceSpan<"model.generate"> = {} as TraceSpan<"tool.execute">;
void mismatched;

const compactOutput: SpanOutputMap["context.compact"] = {
    messageCountBefore: 10,
    messageCountAfter: 4,
    summarizedMessageCount: 6,
    retainedMessageCount: 4,
    tokensBefore: 100,
    tokensAfter: 40,
    fallbackUsed: false,
};
void compactOutput;

// @ts-expect-error public safeError override is forbidden.
tracer.span("model.generate", { provider: "x", model: "x", messages: [] }, async () => undefined, { safeError: false });

declare const modelHandle: TraceSpanHandle<"model.generate">;
modelHandle.setTokenUsage({ inputTokens: 1, outputTokens: 1 });
declare const nonModel: TraceSpanHandle<"tool.execute">;
// @ts-expect-error model.generate is the only span exposing setTokenUsage.
nonModel.setTokenUsage;
