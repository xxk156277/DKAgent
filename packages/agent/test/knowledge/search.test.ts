import assert from "node:assert/strict";
import test from "node:test";
import { initializeKnowledgeSchema, openKnowledgeDatabase } from "../../src/knowledge/database.js";
import type { EmbeddingProvider } from "../../src/knowledge/embedding.js";
import { KnowledgeRepository } from "../../src/knowledge/repository.js";
import { KnowledgeSearch } from "../../src/knowledge/search.js";
import type { KnowledgeEntry } from "../../src/knowledge/types.js";

function entry(id: string, dimension: string, question: string, answer: string): KnowledgeEntry {
    return {
        id,
        dimension,
        question,
        expertAnswer: answer,
        sourceFile: `${dimension}/source.md`,
        content: `问题：${question}\n\n高手答：${answer}`,
    };
}

test("支持 FTS、Embedding 和 Hybrid RRF 三种检索", async () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);
        const repository = new KnowledgeRepository(database);
        const entries = [
            entry("js#1", "javascript", "闭包是什么？", "闭包保留词法环境与作用域。"),
            entry("js#2", "javascript", "事件循环是什么？", "任务队列驱动异步回调。"),
            entry("css#1", "css", "层叠上下文是什么？", "层叠规则决定元素层级。"),
        ];
        repository.syncEntries(entries);
        repository.saveEmbeddings([
            { knowledgeId: "js#1", vector: [1, 0], model: "fake", contentHash: "h1" },
            { knowledgeId: "js#2", vector: [0, 1], model: "fake", contentHash: "h2" },
            { knowledgeId: "css#1", vector: [0.7, 0.7], model: "fake", contentHash: "h3" },
        ]);
        const provider: EmbeddingProvider = {
            model: "fake",
            embedBatch: async () => [[0, 1]],
        };
        const search = new KnowledgeSearch(repository, provider);

        const fts = await search.search({ query: "词法环境", method: "fts" });
        assert.deepEqual(
            fts.map((item) => item.entry.id),
            ["js#1"],
        );
        assert.equal(fts[0]?.matchType, "fts");

        const semantic = await search.search({ query: "异步机制", method: "embedding" });
        assert.deepEqual(
            semantic.map((item) => item.entry.id),
            ["js#2", "css#1", "js#1"],
        );
        assert.equal(semantic[0]?.similarity, 1);

        const hybrid = await search.search({ query: "词法环境", method: "hybrid" });
        assert.equal(hybrid[0]?.entry.id, "js#1");
        assert.equal(hybrid[0]?.matchType, "hybrid");
        assert.equal(hybrid[0]?.score, 1 / 61 + 1 / 63);
    } finally {
        database.close();
    }
});

test("Embedding 检索支持维度过滤并拒绝向量维度不一致", async () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);
        const repository = new KnowledgeRepository(database);
        repository.syncEntries([
            entry("js#1", "javascript", "闭包是什么？", "词法环境。"),
            entry("css#1", "css", "层叠上下文是什么？", "元素层级。"),
        ]);
        repository.saveEmbeddings([
            { knowledgeId: "js#1", vector: [1, 0], model: "fake", contentHash: "h1" },
            { knowledgeId: "css#1", vector: [0, 1], model: "fake", contentHash: "h2" },
        ]);

        const filtered = new KnowledgeSearch(repository, {
            model: "fake",
            embedBatch: async () => [[1, 0]],
        });
        const results = await filtered.search({
            query: "作用域",
            method: "embedding",
            dimension: "javascript",
        });
        assert.deepEqual(
            results.map((item) => item.entry.id),
            ["js#1"],
        );

        const invalid = new KnowledgeSearch(repository, {
            model: "fake",
            embedBatch: async () => [[1, 0, 0]],
        });
        await assert.rejects(invalid.search({ query: "作用域", method: "embedding" }), /向量维度不一致/);
    } finally {
        database.close();
    }
});

test("Embedding 模式未配置 Provider 时明确失败", async () => {
    const database = openKnowledgeDatabase(":memory:");
    try {
        initializeKnowledgeSchema(database);
        const search = new KnowledgeSearch(new KnowledgeRepository(database));

        await assert.rejects(search.search({ query: "闭包", method: "embedding" }), /Embedding Provider/);
    } finally {
        database.close();
    }
});
