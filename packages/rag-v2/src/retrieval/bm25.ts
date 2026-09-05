/** BM25 索引输入。 */
export interface Bm25Document {
    id: string;
    text: string;
}

/** BM25 检索结果。 */
export interface Bm25SearchResult {
    id: string;
    score: number;
}

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

/**
 * 使用 Node 内置分词器切分中英文，统一大小写和全半角。
 * 标点与空白不参与 BM25，英文错误码中的下划线会保留。
 */
export function tokenizeForBm25(text: string): string[] {
    const normalized = text.normalize("NFKC").toLocaleLowerCase("zh-CN");
    return [...segmenter.segment(normalized)]
        .filter((part) => part.isWordLike)
        .map((part) => part.segment.trim())
        .filter(Boolean);
}

/**
 * 面向当前小语料的内存 BM25：索引只在当前进程存在，不替代 PostgreSQL 持久化。
 */
export class Bm25Index {
    private readonly termFrequencies = new Map<string, Map<string, number>>();
    private readonly documentFrequencies = new Map<string, number>();
    private readonly documentLengths = new Map<string, number>();
    private readonly averageDocumentLength: number;

    constructor(private readonly documents: Bm25Document[]) {
        let totalLength = 0;
        for (const document of documents) {
            const tokens = tokenizeForBm25(document.text);
            const frequencies = new Map<string, number>();
            for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
            this.termFrequencies.set(document.id, frequencies);
            this.documentLengths.set(document.id, tokens.length);
            totalLength += tokens.length;
            for (const token of frequencies.keys()) {
                this.documentFrequencies.set(token, (this.documentFrequencies.get(token) ?? 0) + 1);
            }
        }
        this.averageDocumentLength = documents.length === 0 ? 0 : totalLength / documents.length;
    }

    /** 按标准 BM25 公式返回正分候选。 */
    search(query: string, limit: number): Bm25SearchResult[] {
        if (limit <= 0 || this.documents.length === 0 || this.averageDocumentLength === 0) return [];
        const queryTerms = [...new Set(tokenizeForBm25(query))];
        const results: Bm25SearchResult[] = [];
        const k1 = 1.2;
        const b = 0.75;

        for (const document of this.documents) {
            const frequencies = this.termFrequencies.get(document.id)!;
            const documentLength = this.documentLengths.get(document.id)!;
            let score = 0;
            for (const term of queryTerms) {
                const frequency = frequencies.get(term) ?? 0;
                if (frequency === 0) continue;
                const documentFrequency = this.documentFrequencies.get(term) ?? 0;
                const inverseDocumentFrequency = Math.log(
                    1 + (this.documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
                );
                const denominator = frequency + k1 * (1 - b + b * (documentLength / this.averageDocumentLength));
                score += inverseDocumentFrequency * ((frequency * (k1 + 1)) / denominator);
            }
            if (score > 0) results.push({ id: document.id, score });
        }

        return results.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit);
    }
}
