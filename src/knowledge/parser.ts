
import type {
    KnowledgeEntry,
    ParseKnowledgeResult,
    SkippedKnowledgeBlock
} from './types.js'

export function parseKnowledgeMarkdown(
    markdown: string,
    sourceFile: string
): ParseKnowledgeResult {
    const entries: KnowledgeEntry[] = []
    const skipped: SkippedKnowledgeBlock[] = []

    // 用前瞻切分，
    // 分割点前后的内容都会保留（因为前瞻不消耗字符）
    // ## Q: | ### Q: 切割，并保留Q
    // 再用filter过滤掉没有Q的前后
    const blocks = markdown
        .split(/(?=^#{2,3}\s*Q[：:])/gm)
        .filter((block) => /^#{2,3}\s*Q[：:]/m.test(block));

    for (const [index, block] of blocks.entries()) {
        const blockIndex = index + 1;

        // 后面依次完成：提取问题、答案、跳过判断和 KnowledgeEntry。
        const question = extractQuestion(block);

        const noviceAnswer = extractSection(
            block,
            "新手答",
        );

        const expertAnswer = extractSection(
            block,
            "高手答",
        );

        const gapAnalysis = extractSection(
            block,
            "差距在哪|考察点|关键差距",
        );

        if (!expertAnswer) {
            skipped.push({
                blockIndex,
                question,
                reason: "missing_expert_answer",
            });
            continue;
        }
        const normalizedSourceFile = sourceFile.replaceAll("\\", "/");

        const entry: KnowledgeEntry = {
            // 使用路径和问题序号生成稳定 ID，重复建库不会变化。
            id: `${normalizedSourceFile}#q-${blockIndex}`,

            dimension: getDimension(normalizedSourceFile),
            question,
            expertAnswer,

            // exactOptionalPropertyTypes 开启时，不能主动传入 undefined。
            ...(noviceAnswer ? { noviceAnswer } : {}),
            ...(gapAnalysis ? { gapAnalysis } : {}),

            sourceFile: normalizedSourceFile,
            content: buildSearchContent(
                question,
                expertAnswer,
                gapAnalysis,
            ),
        };

        entries.push(entry);
    }

    return {
        entries, skipped
    }
}

/**
 * 提取问题标题。
 */
function extractQuestion(block: string): string {
    const match = block.match(/^#{2,3}\s*Q[：:]\s*(.+)$/m);
    return match?.[1]?.trim() ?? "";
}

/**
 * 提取指定 Markdown 标记之后的多行内容。
 */
function extractSection(
    block: string,
    labelPattern: string,
): string | undefined {
    // 任一已知区块开始，都代表当前区块结束，避免“新手答”吞掉“高手答”。
    const sectionLabels =
        "新手答|高手答|差距在哪|差距分析|考察点|关键差距|追问";
    const pattern = new RegExp(
        `\\*\\*(?:${labelPattern})\\*\\*[：:]\\s*` +
        `([\\s\\S]*?)` +
        `(?=\\n\\*\\*(?:${sectionLabels})\\*\\*[：:]|\\n---|$)`,
    );

    const value = block.match(pattern)?.[1]?.trim();
    return value || undefined;
}

/**
 * 统一路径格式，并从一级目录中提取知识维度。
 */
function getDimension(sourceFile: string): string {
    const normalizedPath = sourceFile.replaceAll("\\", "/");
    return normalizedPath.split("/")[0] || "general";
}

/**
 * 生成供 FTS5 检索的规范化文本。
 * 不加入 noviceAnswer，避免错误答案影响检索结果。
 */
function buildSearchContent(
    question: string,
    expertAnswer: string,
    gapAnalysis?: string,
): string {
    const sections = [
        `问题：${question}`,
        `高手答：${expertAnswer}`,
    ];

    if (gapAnalysis) {
        sections.push(`差距分析：${gapAnalysis}`);
    }

    return sections.join("\n\n");
}
