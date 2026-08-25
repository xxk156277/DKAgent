import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildKnowledgeBase } from "../src/build.js";
import { initializeKnowledgeSchema, openKnowledgeDatabase } from "../src/database.js";
import type { EmbeddingProvider } from "../src/embedding.js";
import { KnowledgeRepository } from "../src/repository.js";

class FakeEmbeddingProvider implements EmbeddingProvider {
  public readonly model = "fake-build-model";
  /** 每次批量调用收到的原始文本，用于验证增量建库。 */
  public readonly calls: string[][] = [];

  public async embedBatch(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) =>
      text.includes("闭包") ? [1, 0] : [0, 1],
    );
  }
}

test("从 Markdown 建立 FTS5 与 Embedding，并复用未变化向量", async () => {
  const root = await mkdtemp(join(tmpdir(), "dkagent-kb-"));
  const sourceDir = join(root, "knowledge");
  const databasePath = join(root, "data", "knowledge.db");
  await mkdir(join(sourceDir, "01-javascript"), { recursive: true });
  await mkdir(join(sourceDir, "02-browser"), { recursive: true });
  const closurePath = join(sourceDir, "01-javascript", "closure.md");
  await writeFile(
    closurePath,
    "## Q：闭包是什么？\n\n**高手答**：闭包保留词法环境。",
    "utf8",
  );
  await writeFile(
    join(sourceDir, "02-browser", "event-loop.md"),
    [
      "### Q: 事件循环是什么？",
      "",
      "**高手答**：任务队列驱动异步回调。",
      "",
      "### Q: 缺少答案的问题",
      "",
      "**新手答**：不知道。",
    ].join("\n"),
    "utf8",
  );
  const provider = new FakeEmbeddingProvider();

  const first = await buildKnowledgeBase({
    sourceDir,
    databasePath,
    embeddingProvider: provider,
    embeddingBatchSize: 1,
  });
  assert.deepEqual(first, {
    scannedFiles: 2,
    storedEntries: 2,
    skippedQuestions: 1,
    dimensions: 2,
    embeddedEntries: 2,
    reusedEmbeddings: 0,
    databasePath,
  });
  assert.equal(provider.calls.length, 2);

  const database = openKnowledgeDatabase(databasePath);
  try {
    initializeKnowledgeSchema(database);
    const repository = new KnowledgeRepository(database);
    const fts = repository.searchFts("词法环境", 5);
    assert.equal(fts[0]?.entry.sourceFile, "01-javascript/closure.md");
    assert.equal(repository.listStoredVectors(provider.model).length, 2);
  } finally {
    database.close();
  }

  provider.calls.length = 0;
  const second = await buildKnowledgeBase({
    sourceDir,
    databasePath,
    embeddingProvider: provider,
  });
  assert.equal(second.embeddedEntries, 0);
  assert.equal(second.reusedEmbeddings, 2);
  assert.equal(provider.calls.length, 0);

  const original = await readFile(closurePath, "utf8");
  await writeFile(closurePath, `${original}\n\n补充：作用域链。`, "utf8");
  const third = await buildKnowledgeBase({
    sourceDir,
    databasePath,
    embeddingProvider: provider,
  });
  assert.equal(third.embeddedEntries, 1);
  assert.equal(third.reusedEmbeddings, 1);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.length, 1);
});

test("零知识输入不会覆盖现有数据库", async () => {
  const root = await mkdtemp(join(tmpdir(), "dkagent-empty-kb-"));
  const sourceDir = join(root, "empty");
  await mkdir(sourceDir, { recursive: true });
  const databasePath = join(root, "existing.db");
  await writeFile(databasePath, "do-not-touch", "utf8");

  await assert.rejects(
    buildKnowledgeBase({
      sourceDir,
      databasePath,
      embeddingProvider: new FakeEmbeddingProvider(),
    }),
    /0 条可入库知识/,
  );
  assert.equal(await readFile(databasePath, "utf8"), "do-not-touch");
});
