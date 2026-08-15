import type { ToolResult } from "../types.js";

export function toolFailure(error: unknown): ToolResult<never> {
    const value = error as NodeJS.ErrnoException & { name?: string };
    if (value?.name === "AbortError" || value?.code === "ABORT_ERR") {
        return { success: false, error: { code: "timeout", message: "操作已中止" } };
    }
    if (value?.code === "EACCES" || value?.code === "EPERM") {
        return {
            success: false,
            error: { code: "permission_denied", message: value.message },
        };
    }
    return {
        success: false,
        error: {
            code: "service_error",
            message: error instanceof Error ? error.message : String(error),
        },
    };
}
