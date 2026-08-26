import assert from "node:assert/strict";
import test from "node:test";
import { hasValidCitations } from "../src/ask.js";
import { formatCliError } from "../src/errors.js";

test("引用必须存在且落在实际来源编号内", () => {
    assert.equal(hasValidCitations("结论 [1]，补充 [3]", 3), true);
    assert.equal(hasValidCitations("没有引用", 3), false);
    assert.equal(hasValidCitations("伪造来源 [4]", 3), false);
});

test("鉴权错误不会输出服务端返回的密钥片段", () => {
    const error = Object.assign(new Error("api key ****abcd is invalid"), { statusCode: 401 });
    assert.equal(formatCliError(error), "模型服务鉴权失败，请更新对应 API Key");
});
