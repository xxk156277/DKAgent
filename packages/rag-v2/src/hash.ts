/**
 * 哈希工具模块
 *
 * 提供 SHA-256 摘要能力，供解析与索引模块生成稳定 ID 和内容去重哈希使用。
 */
import { createHash } from "node:crypto";

/**
 * 计算字符串的 SHA-256 摘要（十六进制）。
 *
 * 用于生成文档 / 子块 / 内容的稳定 ID 与去重哈希。
 */
export function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}
