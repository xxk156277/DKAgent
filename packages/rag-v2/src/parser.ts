/**
 * Markdown 文档解析与分块
 *
 * - 用 remark 解析 Markdown 得到 AST，按 H1-H3 标题把文档切分为章节（Section）
 * - 超长章节按 maxChunkChars 继续切分，并带 overlap 重叠避免切碎语义
 * - 提取图片引用（Markdown / Obsidian 语法），判断章节是否需要多模态理解（needsVision）
 * - 基于路径 / 标题 / 序号生成稳定的子块 ID 与内容哈希
 */
import path from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { ChildChunk, ImageReference, ParsedDocument } from "./types.js";
import { sha256 } from "./hash.js";

/** remark AST 节点的最小结构（用于读取标题层级与文本、位置偏移）。 */
interface AstNode {
    type: string;
    depth?: number;
    children?: AstNode[];
    value?: string;
    position?: { start?: { offset?: number }; end?: { offset?: number } };
}

/** 一个章节：heading 路径、同级标题序号（去重）与章节正文。 */
interface Section {
    headingPath: string[];
    headingOrdinal: number;
    content: string;
}

/** 解析选项：子块最大字符数与重叠字符数。 */
export interface ParseOptions {
    maxChunkChars?: number;
    overlapChars?: number;
}

/** 递归提取 AST 节点的纯文本内容。 */
function nodeText(node: AstNode): string {
    if (typeof node.value === "string") return node.value;
    return (node.children ?? []).map(nodeText).join("");
}

/**
 * 把 Markdown 按 H1-H3 标题切分为章节：
 * - 维护当前 heading 路径；同级重复标题用 ordinal 区分
 * - 标题之前且非空的正文作为无标题引言（prelude）
 */
function extractSections(markdown: string): Section[] {
    const root = unified().use(remarkParse).parse(markdown) as AstNode;
    const nodes = root.children ?? [];
    const headings = nodes.filter((node) => node.type === "heading" && node.depth !== undefined && node.depth <= 3);

    if (headings.length === 0) {
        return markdown.trim() ? [{ headingPath: [], headingOrdinal: 0, content: markdown.trim() }] : [];
    }

    const sections: Section[] = [];
    const headingPath: string[] = [];
    const duplicateCounts = new Map<string, number>();
    const firstHeadingOffset = headings[0]?.position?.start?.offset ?? 0;
    const prelude = markdown.slice(0, firstHeadingOffset).trim();
    if (prelude) sections.push({ headingPath: [], headingOrdinal: 0, content: prelude });

    for (let index = 0; index < headings.length; index += 1) {
        const heading = headings[index]!;
        const depth = heading.depth!;
        const title = nodeText(heading).trim();
        headingPath.splice(depth - 1);
        headingPath[depth - 1] = title;
        const currentPath = headingPath.filter(Boolean);
        const duplicateKey = currentPath.join("\u0000");
        const ordinal = duplicateCounts.get(duplicateKey) ?? 0;
        duplicateCounts.set(duplicateKey, ordinal + 1);

        const start = heading.position?.start?.offset ?? 0;

        const end = headings[index + 1]?.position?.start?.offset ?? markdown.length;
        const content = markdown.slice(start, end).trim();
        if (content) {
            sections.push({ headingPath: [...currentPath], headingOrdinal: ordinal, content });
        }
    }
    return sections;
}

/**
 * 超长章节按 maxChars 切分：优先在段落/换行处断开，并保留 overlapChars 重叠避免切断语义。
 */
function splitOversized(content: string, maxChars: number, overlapChars: number): string[] {
    if (content.length <= maxChars) return [content];
    const chunks: string[] = [];
    let start = 0;
    while (start < content.length) {
        let end = Math.min(start + maxChars, content.length);
        if (end < content.length) {
            const paragraphBreak = content.lastIndexOf("\n\n", end);
            const lineBreak = content.lastIndexOf("\n", end);
            const preferred = paragraphBreak > start + maxChars / 2 ? paragraphBreak : lineBreak;
            if (preferred > start + maxChars / 2) end = preferred;
        }
        const part = content.slice(start, end).trim();
        if (part) chunks.push(part);
        if (end >= content.length) break;
        start = Math.max(start + 1, end - overlapChars);
    }
    return chunks;
}

/**
 * 提取文本中的图片引用（Markdown 语法 ![]() 与 Obsidian 语法 ![[]]）。
 */
export function extractImageReferences(content: string): ImageReference[] {
    const refs: ImageReference[] = [];
    for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        refs.push({ kind: "markdown", alt: match[1] || undefined, target: match[2]!.trim() });
    }
    for (const match of content.matchAll(/!\[\[([^\]]+)\]\]/g)) {
        const [target, alt] = match[1]!.split("|", 2);
        refs.push({ kind: "obsidian", target: target!.trim(), alt: alt?.trim() || undefined });
    }

    return refs;
}

/**
 * 判断章节是否主要依赖图片（去除图片/标题后可见文字很少则视为需要多模态理解）。
 */
function detectNeedsVision(content: string, refs: ImageReference[]): boolean {
    if (refs.length === 0) return false;
    const visibleText = content
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
        .replace(/!\[\[[^\]]+\]\]/g, "")
        .replace(/^#{1,6}\s+.*$/gm, "")
        .replace(/\s+/g, "")
        .trim();

    return visibleText.length < 120;
}

/**
 * 解析一个 Markdown 文件为父文档 + 子块列表。
 *
 * @param absolutePath 源文件绝对路径
 * @param vaultRoot Vault 根目录（用于计算相对路径作为稳定标识）
 * @param rawContent 文件原始内容
 * @param modifiedAt 文件修改时间
 * @param options 分块参数（最大字符数 / 重叠字符数）
 */
export function parseMarkdownDocument(
    absolutePath: string,
    vaultRoot: string,
    rawContent: string,
    modifiedAt: Date,
    options: ParseOptions = {},
): ParsedDocument {
    const maxChunkChars = options.maxChunkChars ?? 1600;
    const overlapChars = options.overlapChars ?? 160;
    if (overlapChars >= maxChunkChars) {
        throw new Error("overlapChars 必须小于 maxChunkChars");
    }
    const parsedMatter = matter(rawContent);
    const relativePath = path.relative(vaultRoot, absolutePath).split(path.sep).join("/");
    const parentId = sha256(relativePath);
    const sections = extractSections(parsedMatter.content);
    const chunks: ChildChunk[] = [];

    for (const section of sections) {
        const parts = splitOversized(section.content, maxChunkChars, overlapChars);
        parts.forEach((content, splitIndex) => {
            const identity = [parentId, ...section.headingPath, section.headingOrdinal, splitIndex].join("\u0000");
            const imageRefs = extractImageReferences(content);
            chunks.push({
                id: sha256(identity),
                parentId,
                sourcePath: relativePath,
                headingPath: section.headingPath,
                headingOrdinal: section.headingOrdinal,
                splitIndex,
                content,
                contentHash: sha256(content),
                imageRefs,
                needsVision: detectNeedsVision(content, imageRefs),
            });
        });
    }

    const firstHeading = sections.find((section) => section.headingPath.length > 0)?.headingPath[0];
    return {
        parent: {
            id: parentId,
            sourcePath: relativePath,
            title: firstHeading || path.basename(relativePath, path.extname(relativePath)),
            content: rawContent,
            contentHash: sha256(rawContent),
            frontmatter: JSON.parse(JSON.stringify(parsedMatter.data)) as Record<string, unknown>,
            modifiedAt,
        },
        chunks,
    };
}
