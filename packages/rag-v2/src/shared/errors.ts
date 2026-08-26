/**
 * CLI 错误格式化工具
 *
 * 将底层异常转换为面向用户的友好提示：
 * - 401 / 403 → 模型服务鉴权失败
 * - 其它 HTTP 状态码 → 带状态码的请求失败
 * - 普通异常 → 异常消息
 */
export function formatCliError(error: unknown): string {
    if (typeof error === "object" && error !== null && "statusCode" in error) {
        const statusCode = (error as { statusCode?: unknown }).statusCode;
        if (statusCode === 401 || statusCode === 403) return "模型服务鉴权失败，请更新对应 API Key";
        if (typeof statusCode === "number") return `模型服务请求失败（HTTP ${statusCode}）`;
    }
    return error instanceof Error ? error.message : String(error);
}
