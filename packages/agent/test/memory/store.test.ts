import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteMemoryStore } from "../../src/memory/store.js";

function createStore(): SqliteMemoryStore {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-memory-"));
    return new SqliteMemoryStore(join(directory, "memory.db"));
}

test("关闭再打开后仍可读取记忆", () => {
    const directory = mkdtempSync(join(tmpdir(), "dkagent-memory-"));
    const databasePath = join(directory, "memory.db");
    const firstStore = new SqliteMemoryStore(databasePath);
    const saved = firstStore.upsert({
        type: "preference",
        key: "answer_style",
        content: "先讲架构",
        source: "explicit",
        sourceSessionId: "session-1",
    });
    firstStore.close();

    const secondStore = new SqliteMemoryStore(databasePath);
    assert.deepEqual(secondStore.list(), [saved]);
    secondStore.close();
});

test("相同 type/key 更新而不重复，automatic 不覆盖 explicit", () => {
    const store = createStore();
    const first = store.upsert({
        type: "preference",
        key: "answer_style",
        content: "先讲架构",
        source: "explicit",
        sourceSessionId: "session-1",
    });
    const ignored = store.upsert({
        type: "preference",
        key: "answer_style",
        content: "只给代码",
        source: "automatic",
        sourceSessionId: "session-2",
    });

    assert.equal(ignored.id, first.id);
    assert.equal(ignored.content, "先讲架构");
    assert.equal(store.list().length, 1);

    const updated = store.upsert({
        type: "preference",
        key: "answer_style",
        content: "先给结论",
        source: "explicit",
        sourceSessionId: "session-3",
    });
    assert.equal(updated.id, first.id);
    assert.equal(updated.content, "先给结论");
    assert.equal(store.list().length, 1);
    store.close();
});

test("explicit 可以覆盖 automatic", () => {
    const store = createStore();
    const automatic = store.upsert({
        type: "profile",
        key: "role",
        content: "前端工程师",
        source: "automatic",
        sourceSessionId: "session-1",
    });
    const updatedAutomatic = store.upsert({
        type: "profile",
        key: "role",
        content: "前端开发工程师",
        source: "automatic",
        sourceSessionId: "session-2",
    });
    const explicit = store.upsert({
        type: "profile",
        key: "role",
        content: "全栈 Agent 工程师",
        source: "explicit",
        sourceSessionId: "session-3",
    });

    assert.equal(explicit.id, automatic.id);
    assert.equal(explicit.createdAt, automatic.createdAt);
    assert.equal(updatedAutomatic.id, automatic.id);
    assert.equal(updatedAutomatic.content, "前端开发工程师");
    assert.equal(explicit.content, "全栈 Agent 工程师");
    assert.equal(explicit.source, "explicit");
    assert.equal(explicit.sourceSessionId, "session-3");
    store.close();
});

test("list 按更新时间倒序并支持 limit 和 type", () => {
    const store = createStore();
    const first = store.upsert({
        type: "profile",
        key: "city",
        content: "上海",
        source: "explicit",
        sourceSessionId: "session-1",
    });
    const second = store.upsert({
        type: "decision",
        key: "stack",
        content: "使用 TypeScript",
        source: "explicit",
        sourceSessionId: "session-1",
    });

    assert.deepEqual(store.list({ limit: 1 }), [second]);
    assert.deepEqual(store.list({ type: "profile" }), [first]);
    assert.throws(() => store.list({ limit: 0 }), /limit/);
    assert.throws(() => store.list({ limit: 101 }), /limit/);
    assert.throws(() => store.list({ limit: 1.5 }), /limit/);
    store.close();
});

test("delete 返回是否实际删除", () => {
    const store = createStore();
    const memory = store.upsert({
        type: "decision",
        key: "editor",
        content: "使用 VS Code",
        source: "explicit",
        sourceSessionId: "session-1",
    });

    assert.equal(store.delete(memory.id), true);
    assert.equal(store.delete(memory.id), false);
    assert.deepEqual(store.list(), []);
    store.close();
});

test("非法候选记忆会被拒绝", () => {
    const store = createStore();
    const input = {
        type: "preference" as const,
        source: "explicit" as const,
        sourceSessionId: "session-1",
    };

    assert.throws(() => store.upsert({ ...input, key: "Answer Style", content: "简洁" }), /key/);
    assert.throws(() => store.upsert({ ...input, key: "style", content: "   " }), /content/);
    assert.throws(
        () => store.upsert({ ...input, key: "style", content: "x".repeat(501) }),
        /content/,
    );
    assert.throws(
        () => store.upsert({ ...input, key: "style", content: "保存 api key" }),
        /凭据/,
    );
    for (const credential of [
        "api-key",
        "api_key",
        "apikey",
        "access-token",
        "access_token",
        "accesstoken",
        "refresh-token",
        "refresh_token",
        "refreshtoken",
    ]) {
        assert.throws(
            () => store.upsert({ ...input, key: "style", content: `保存 ${credential}` }),
            /凭据/,
        );
    }
    store.close();
});

test("非法 source 在读取或写入前被拒绝", () => {
    const store = createStore();
    const explicit = store.upsert({
        type: "preference",
        key: "answer_style",
        content: "先讲架构",
        source: "explicit",
        sourceSessionId: "session-1",
    });
    const invalidInput = {
        type: "preference",
        key: "answer_style",
        content: "只给代码",
        source: "manual",
        sourceSessionId: "session-2",
    } as unknown as import("../../src/memory/types.js").MemoryUpsertInput;

    assert.throws(() => store.upsert(invalidInput), /source/);
    assert.deepEqual(store.list(), [explicit]);
    store.close();
});
