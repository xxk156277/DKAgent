import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSafePrompt } from "../../src/cli/safe-prompt.js";

class FakeReadline extends EventEmitter {
    promptCount = 0;
    closed = false;

    prompt(): void {
        if (this.closed) throw new Error("readline was closed");
        this.promptCount += 1;
    }

    close(): void {
        this.closed = true;
        this.emit("close");
    }
}

test("readline 关闭后不再输出提示符", () => {
    const readline = new FakeReadline();
    const prompt = createSafePrompt(readline);

    prompt();
    readline.close();

    assert.doesNotThrow(() => prompt());
    assert.equal(readline.promptCount, 1);
});
