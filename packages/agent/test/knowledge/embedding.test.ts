import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAICompatibleEmbeddingProvider,
  createEmbeddingProviderFromEnv,
} from "../../src/knowledge/embedding.js";

test("OpenAI 兼容 Provider 发送批量请求并按 index 恢复顺序", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey: "test-key",
    baseUrl: "https://embedding.example.com/v1/",
    model: "embedding-test",
    fetch: fakeFetch,
  });

  const vectors = await provider.embedBatch(["问题一", "问题二"]);

  assert.equal(capturedUrl, "https://embedding.example.com/v1/embeddings");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "embedding-test",
    input: ["问题一", "问题二"],
  });
  assert.equal(
    (capturedInit?.headers as Record<string, string>).Authorization,
    "Bearer test-key",
  );
  assert.deepEqual(vectors, [
    [1, 0],
    [0, 1],
  ]);
});

test("Provider 校验响应数量、维度和有限数字", async () => {
  const createProvider = (data: unknown[]) =>
    new OpenAICompatibleEmbeddingProvider({
      apiKey: "test-key",
      baseUrl: "https://embedding.example.com/v1",
      model: "embedding-test",
      fetch: async () =>
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

  await assert.rejects(
    createProvider([{ index: 0, embedding: [1, 0] }]).embedBatch(["a", "b"]),
    /数量不一致/,
  );
  await assert.rejects(
    createProvider([
      { index: 0, embedding: [1, 0] },
      { index: 1, embedding: [1] },
    ]).embedBatch(["a", "b"]),
    /维度不一致/,
  );
  await assert.rejects(
    createProvider([{ index: 0, embedding: [Number.NaN] }]).embedBatch(["a"]),
    /有限数字/,
  );
});

test("Provider 保留非 2xx 错误信息但不泄露 API Key", async () => {
  const provider = new OpenAICompatibleEmbeddingProvider({
    apiKey: "secret-value",
    baseUrl: "https://embedding.example.com/v1",
    model: "embedding-test",
    fetch: async () => new Response("quota exceeded", { status: 429 }),
  });

  await assert.rejects(provider.embedBatch(["a"]), (error: unknown) => {
    assert.match(String(error), /429.*quota exceeded/);
    assert.doesNotMatch(String(error), /secret-value/);
    return true;
  });
});

test("环境变量缺失时明确指出配置名", () => {
  assert.throws(
    () => createEmbeddingProviderFromEnv({}),
    /EMBEDDING_API_KEY.*EMBEDDING_BASE_URL.*EMBEDDING_MODEL_ID/,
  );
});
