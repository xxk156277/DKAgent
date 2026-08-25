export function formatCliError(error: unknown): string {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (statusCode === 401 || statusCode === 403) return "模型服务鉴权失败，请更新对应 API Key";
    if (typeof statusCode === "number") return `模型服务请求失败（HTTP ${statusCode}）`;
  }
  return error instanceof Error ? error.message : String(error);
}
