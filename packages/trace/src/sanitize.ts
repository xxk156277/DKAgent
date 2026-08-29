import type { JsonValue } from "./types.js";

const exactSensitive = new Set([
    "authorization", "header", "headers", "env", "environment", "password", "secret", "token",
    "accesstoken", "refreshtoken", "bearertoken", "clientsecret",
]);

function isSensitiveKey(key: string): boolean {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return exactSensitive.has(normalized) || normalized.endsWith("apikey");
}

export function sanitizeJson(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [
            key,
            isSensitiveKey(key) ? "[REDACTED]" : sanitizeJson(child),
        ]));
    }
    return value;
}

export function sanitizeError(error: unknown, safe = false): { name: string; code?: string; message?: string } {
    try {
        const value = error as { name?: unknown; code?: unknown; message?: unknown } | null;
        const name = typeof value?.name === "string" ? value.name : "Error";
        const code = typeof value?.code === "string" ? value.code : undefined;
        if (safe) return code === undefined ? { name } : { name, code };
        const message = typeof value?.message === "string" ? value.message : String(error);
        return code === undefined ? { name, message } : { name, code, message };
    } catch {
        return { name: "Error" };
    }
}
