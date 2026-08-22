import type { ToolCall } from "../query-engine/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";

export interface DispatchedToolResult {
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
    result: ToolResult;
}

export async function dispatchToolCall(
    registry: ToolRegistry,
    call: ToolCall,
    context: ToolContext,
): Promise<DispatchedToolResult> {
    try {
        const tool = registry.resolve(call.name);
        const result = await tool.execute(call.input, context);
        return { toolCallId: call.id, name: call.name, input: call.input, result };
    } catch (error: unknown) {
        return {
            toolCallId: call.id,
            name: call.name,
            input: call.input,
            result: {
                success: false,
                error: {
                    code: "input_error",
                    message: error instanceof Error ? error.message : String(error),
                },
            },
        };
    }
}
