import type { QueryEngine } from "../query-engine/query-engine.js";
import type { Tracer } from "@dkagent/trace";
import type { ArtifactStore } from "../artifact/types.js";

export interface Tool<TInput = unknown, TOutput = unknown> {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    execute(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export type AnyTool = Tool<any, any>;

export interface ToolResult<T = unknown> {
    success: boolean;
    data?: T;
    error?: {
        code: "input_error" | "service_error" | "timeout" | "permission_denied";
        message: string;
    };
}

export interface ToolContext {
    queryEngine: QueryEngine;
    abortSignal: AbortSignal;
    tracer?: Tracer;
    artifactStore?: ArtifactStore;
}

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
