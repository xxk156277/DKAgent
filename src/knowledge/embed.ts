import OpenAI from 'openai';
import { KnowledgeEntry } from './types';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100;   // OpenAI embedding API 单次最多 2048，100 比较安全
const EMBEDDING_DIM = 1536;

export async function generateEmbeddings(
    entries: KnowledgeEntry[],
    apiKey: string,
): Promise<KnowledgeEntry[]> {
    const client = new OpenAI({ apiKey });
    const results: KnowledgeEntry[] = [];

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        const texts = batch.map(e => buildEmbeddingText(e));

        const response = await client.embeddings.create({
            model: EMBEDDING_MODEL,
            input: texts,
        });

        for (let j = 0; j < batch.length; j++) {
            results.push({
                ...batch[j],
                embedding: new Float32Array(response.data[j].embedding),
            });
        }

        console.log(`Embedded ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length}`);

        // 限流：避免打满 API
        if (i + BATCH_SIZE < entries.length) {
            await sleep(200);
        }
    }

    return results;
}

function buildEmbeddingText(entry: KnowledgeEntry): string {
    // 拼接 question + expertAnswer 的前 500 字作为 embedding 输入
    // 原因：question 太短语义不够，expertAnswer 太长浪费 token
    const expert = entry.expertAnswer.slice(0, 500);
    return `问题：${entry.question}\n答案：${expert}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}