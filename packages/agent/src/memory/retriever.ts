import { MemoryFormatter } from "./formatter.js";
import type { MemoryEntry, MemoryReader, MemoryStore } from "./types.js";

/** 从当前用户输入提取稳定的 ASCII 词元和中文双字词元。
 * 1.英文/数字按完整单词切分：小写化后整体匹配，提取英文，忽略标点符号
 * 2. 中文用双字 bigram 切分：中文没有天然的空格分词，用相邻两个字组成一个词元。比如「打开飞书文档」会被切成「打开」「开飞」「飞书」「书文」「文档」。
 * 3. 返回 `Set` 而不是数组：自动去重，查找效率高
 */
function tokenize(value: string): Set<string> {
    const tokens = new Set<string>(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const chineseChars = value.match(/[\u3400-\u9fff]/gu) ?? [];

    for (let index = 0; index + 1 < chineseChars.length; index += 1) {
        tokens.add(chineseChars.slice(index, index + 2).join(""));
    }

    return tokens;
}

/**
 * 计算一条记忆条目与当前查询之间词元重合度，重合度越高相关性分数
 */
function relevanceScore(queryTokens: ReadonlySet<string>, entry: MemoryEntry): number {
    const entryTokens = tokenize(`${entry.key} ${entry.content}`);
    let score = 0;

    for (const token of queryTokens) {
        if (entryTokens.has(token)) {
            score += 1;
        }
    }

    return score;
}

/** 确定性选择适合当前请求的长期记忆。 */
export class MemoryRetriever implements MemoryReader {
    private readonly formatter = new MemoryFormatter();

    public constructor(private readonly store: MemoryStore) {}

    public async recall(query: string): Promise<string> {
        const entries = this.store.list({ limit: 100 });

        const profile = entries.filter((entry) => entry.type === "profile").slice(0, 4);
        const preference = entries.filter((entry) => entry.type === "preference").slice(0, 4);

        const queryTokens = tokenize(query);

        const decisions = entries
            .filter((entry) => entry.type === "decision")
            .map((entry) => ({
                entry,
                score: relevanceScore(queryTokens, entry),
            }))
            .filter(({ score }) => score > 0)
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
                    left.entry.id.localeCompare(right.entry.id),
            )
            .slice(0, 3)
            .map(({ entry }) => entry);

        return this.formatter.format([...profile, ...preference, ...decisions].slice(0, 10));
    }
}
