import { importAll } from './import';
import { generateEmbeddings } from './embed';
import { KnowledgeStore } from './store';

export async function buildKnowledgeBase(opts: {
    interviewDir: string;
    dbPath: string;
    openaiApiKey: string;
}): Promise<void> {
    console.log('Step 1/3: Parsing Markdown files...');
    const entries = importAll(opts.interviewDir);
    console.log(`  → Parsed ${entries.length} questions`);

    console.log('Step 2/3: Generating embeddings...');
    const withEmbeddings = await generateEmbeddings(entries, opts.openaiApiKey);
    console.log(`  → Generated ${withEmbeddings.length} embeddings`);

    console.log('Step 3/3: Storing to SQLite...');
    const store = new KnowledgeStore(opts.dbPath);
    store.insertBatch(withEmbeddings);

    const stats = store.getStats();
    console.log(`\nDone! Knowledge base ready:`);
    console.log(`  Total entries: ${stats.totalEntries}`);
    console.log(`  Dimensions: ${stats.dimensions}`);
    console.log(`  With embedding: ${stats.withEmbedding}`);
    console.log(`  Database: ${opts.dbPath}`);
}