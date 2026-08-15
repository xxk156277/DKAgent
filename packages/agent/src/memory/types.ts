/** Memory 的类别。 */
export type MemoryType = "profile" | "preference" | "decision";

/** Memory 的写入来源。 */
export type MemorySource = "explicit" | "automatic";

/** 已持久化的单条 Memory。 */
export interface MemoryEntry {
    /** Memory 唯一标识。 */
    id: string;
    /** 记忆类别。 */
    type: MemoryType;
    /** 同类记忆中稳定、可覆盖的语义键。 */
    key: string;
    /** 注入模型的简短事实文本。 */
    content: string;
    /** 记忆来自显式命令还是自动提取。 */
    source: MemorySource;
    /** 产生或最近更新该记忆的 Session。 */
    sourceSessionId: string;
    /** 首次创建时间。 */
    createdAt: string;
    /** 最近更新时间。 */
    updatedAt: string;
}

/** 等待写入的 Memory 候选。 */
export interface MemoryCandidate {
    /** 候选记忆类别。 */
    type: MemoryType;
    /** 候选记忆的稳定语义键。 */
    key: string;
    /** 候选记忆的简短事实。 */
    content: string;
}

/** 带来源信息的 Memory 写入参数。 */
export interface MemoryUpsertInput extends MemoryCandidate {
    /** 写入来自显式命令还是自动提取。 */
    source: MemorySource;
    /** 产生本次写入的 Session。 */
    sourceSessionId: string;
}

/** Memory 列表查询参数。 */
export interface MemoryListOptions {
    /** 可选类别过滤。 */
    type?: MemoryType;
    /** 最多返回多少条，默认 100。 */
    limit?: number;
}

/** Memory 持久化端口。 */
export interface MemoryStore {
    /** 新建或按 type/key 更新记忆。 */
    upsert(input: MemoryUpsertInput): MemoryEntry;
    /** 按更新时间从新到旧列出记忆。 */
    list(options?: MemoryListOptions): MemoryEntry[];
    /** 按 ID 删除记忆，不存在时返回 false。 */
    delete(id: string): boolean;
}

/** Memory 语义键允许的格式。 */
export const MEMORY_KEY_PATTERN = /^[a-z0-9._-]{1,64}$/;

/** Memory 内容允许的最大字符数。 */
export const MAX_MEMORY_CONTENT_CHARS = 500;

/** 单轮自动提取允许的最大 Memory 数。 */
export const MAX_AUTOMATIC_MEMORIES_PER_TURN = 3;

const MEMORY_TYPES: readonly MemoryType[] = ["profile", "preference", "decision"];
const CREDENTIAL_PATTERN = /api key|access token|refresh token|password|secret|验证码|密码|密钥/i;

/** 校验并规范化待保存的 Memory 候选。 */
export function validateMemoryCandidate(candidate: MemoryCandidate): MemoryCandidate {
    if (!MEMORY_TYPES.includes(candidate.type)) {
        throw new Error("Memory 类别不合法");
    }

    const key = candidate.key.trim();
    if (!MEMORY_KEY_PATTERN.test(key)) {
        throw new Error("Memory key 必须是 1～64 位小写英文、数字、点、下划线或短横线");
    }

    const content = candidate.content.trim();
    if (content.length === 0 || content.length > MAX_MEMORY_CONTENT_CHARS) {
        throw new Error(`Memory content 必须是 1～${MAX_MEMORY_CONTENT_CHARS} 个字符`);
    }
    if (CREDENTIAL_PATTERN.test(content)) {
        throw new Error("Memory content 不能包含凭据语义");
    }

    return { type: candidate.type, key, content };
}
