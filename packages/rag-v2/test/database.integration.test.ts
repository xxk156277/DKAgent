import assert from "node:assert/strict";
import test from "node:test";
import { RagDatabase } from "../src/database.js";
import type { ChildChunk, ParentDocument } from "../src/types.js";

const connectionString = process.env.RAG_TEST_DATABASE_URL;

test("pgvector 迁移、事务替换、余弦检索和删除同步", { skip: !connectionString }, async () => {
  const database = new RagDatabase(connectionString!);
  const vectorA = Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0));
  const vectorB = Array.from({ length: 1024 }, (_, index) => (index === 1 ? 1 : 0));
  const parent = (id: string): ParentDocument => ({
    id,
    sourcePath: `__integration__/${id}.md`,
    title: id,
    content: `# ${id}`,
    contentHash: `hash-${id}`,
    frontmatter: {},
    modifiedAt: new Date("2026-08-25T00:00:00Z"),
  });
  const chunk = (id: string): ChildChunk => ({
    id: `chunk-${id}`,
    parentId: id,
    sourcePath: `__integration__/${id}.md`,
    headingPath: [id],
    headingOrdinal: 0,
    splitIndex: 0,
    content: id,
    contentHash: `chunk-hash-${id}`,
    imageRefs: [],
    needsVision: false,
  });

  try {
    await database.migrate();
    await database.pool.query("TRUNCATE rag_documents CASCADE");
    await database.replaceDocument(parent("a"), [chunk("a")], [vectorA]);
    await database.replaceDocument(parent("b"), [chunk("b")], [vectorB]);
    const hits = await database.searchChildren(vectorA, 2);
    assert.equal(hits[0]?.parentId, "a");

    const updated = { ...chunk("a"), content: "updated", contentHash: "updated" };
    await database.replaceDocument({ ...parent("a"), contentHash: "updated" }, [updated], [vectorA]);
    assert.equal((await database.getDocument("a"))?.chunks[0]?.content, "updated");

    const deleted = await database.deleteMissingDocuments(["__integration__/a.md"]);
    assert.equal(deleted, 1);
    const index = await database.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'rag_chunks_embedding_hnsw_idx'",
    );
    assert.equal(index.rowCount, 1);
  } finally {
    await database.close();
  }
});
