import type { TraceEventName } from "@dkagent/trace";
import type { ToolContext } from "../tools/types.js";

/** Skill 内部阶段使用独立 Span，避免伪造成 Agent 的 Tool Call。 */
export async function observeSkillOperation<T>(input: {
    context: ToolContext;
    name: Extract<TraceEventName, "skill.run" | "skill.stage">;
    operation: string;
    traceInput: unknown;
    execute: () => Promise<T>;
    summarizeOutput: (value: T) => unknown;
}): Promise<T> {
    if (!input.context.tracer) return input.execute();
    return input.context.tracer.span(
        input.name,
        input.traceInput,
        async (span) => {
            const value = await input.execute();
            span.setOutput(input.summarizeOutput(value));
            return value;
        },
        { module: "skill", operation: input.operation },
    );
}
