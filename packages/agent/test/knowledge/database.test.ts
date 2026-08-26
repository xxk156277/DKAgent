import assert from "node:assert/strict";
import test from "node:test";
import { initializeKnowledgeSchema, openKnowledgeDatabase } from "../../src/knowledge/database.js";
import { KnowledgeRepository } from "../../src/knowledge/repository.js";
import type { KnowledgeEntry } from "../../src/knowledge/types.js";
import { decodeVector, encodeVector } from "../../src/knowledge/vector.js";

function createEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
    return {
        id: "javascript/closure.md#q-1",
        dimension: "javascript",
        question: "闭包是什么？",
        expertAnswer: "闭包是函数与词法环境的组合。",
        sourceFile: "javascript/closure.md",
        content: "问题：闭包是什么？\n\n高手答：闭包是函数与词法环境的组合。",
        ...overrides,
    };
}

test("初始化知识表、FTS5 和 Embedding 表", () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);

        const names = database
            .prepare(
                "SELECT name FROM sqlite_master WHERE name IN ('knowledge', 'knowledge_fts', 'embeddings') ORDER BY name",
            )
            .all()
            .map((row) => (row as { name: string }).name);

        assert.deepEqual(names, ["embeddings", "knowledge", "knowledge_fts"]);
        assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    } finally {
        database.close();
    }
});

test("FTS Trigger 跟随知识的新增、更新和删除", () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);
        const repository = new KnowledgeRepository(database);

        repository.syncEntries([createEntry()]);
        assert.equal(repository.searchFts("词法环境", 5).length, 1);

        repository.syncEntries([
            createEntry({
                expertAnswer: "闭包可以保留外层作用域。",
                content: "问题：闭包是什么？\n\n高手答：闭包可以保留外层作用域。",
            }),
        ]);
        assert.equal(repository.searchFts("词法环境", 5).length, 0);
        assert.equal(repository.searchFts("外层作用域", 5).length, 1);

        repository.syncEntries([createEntry({ id: "javascript/other.md#q-1" })]);
        assert.equal(repository.searchFts("外层作用域", 5).length, 0);
    } finally {
        database.close();
    }
});

test("Float32 向量能够往返，并拒绝非法输入", () => {
    const encoded = encodeVector([0.25, -0.5, 1]);

    assert.deepEqual(decodeVector(encoded, 3), [0.25, -0.5, 1]);
    assert.throws(() => encodeVector([]), /不能为空/);
    assert.throws(() => encodeVector([Number.NaN]), /有限数字/);
    assert.throws(() => decodeVector(Buffer.alloc(5), 2), /字节长度/);
});

test("Repository 增量同步知识和 Embedding 状态", () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);
        const repository = new KnowledgeRepository(database);
        const first = createEntry();

        assert.throws(() => repository.syncEntries([]), /0 条知识/);
        repository.syncEntries([first]);
        assert.equal(repository.count(), 1);
        assert.equal(repository.countDimensions(), 1);

        const pending = repository.findPendingEmbeddings("text-embedding-test");
        assert.equal(pending.length, 1);
        assert.equal(pending[0]?.knowledgeId, first.id);

        repository.saveEmbeddings([
            {
                knowledgeId: first.id,
                vector: [1, 0, 0],
                model: "text-embedding-test",
                contentHash: pending[0]!.contentHash,
            },
        ]);
        assert.equal(repository.findPendingEmbeddings("text-embedding-test").length, 0);
        assert.equal(repository.findPendingEmbeddings("another-model").length, 1);

        repository.syncEntries([
            createEntry({
                content: `${first.content}\n\n补充：作用域链。`,
            }),
        ]);
        assert.equal(repository.findPendingEmbeddings("text-embedding-test").length, 1);

        repository.syncEntries([createEntry({ id: "javascript/new.md#q-1" })]);
        const vectorCount = database.prepare("SELECT count(*) AS count FROM embeddings").get() as { count: number };
        assert.equal(vectorCount.count, 0);
    } finally {
        database.close();
    }
});
