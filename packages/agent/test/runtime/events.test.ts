import assert from "node:assert/strict";
import test from "node:test";
import {
  RuntimeEventPublisher,
  type RuntimeEvent,
} from "../../src/runtime/events.js";

test("事件序号递增，sink 抛错不会向调用方传播", () => {
  const events: RuntimeEvent[] = [];
  const publisher = new RuntimeEventPublisher({
    emit(event) {
      events.push(event);
      if (event.type === "turn.end") throw new Error("tap failed");
    },
  });

  const turnId = publisher.createTurnId();
  publisher.emit("turn.start", turnId, { input: "你好" });
  assert.doesNotThrow(() => {
    publisher.emit("turn.end", turnId, { answer: "你好" });
  });
  assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
  assert.equal(events[0]?.sessionId, events[1]?.sessionId);
});

test("sink 异步拒绝不会产生未处理拒绝", async () => {
  const publisher = new RuntimeEventPublisher({
    async emit() {
      throw new Error("tap async failed");
    },
  });

  publisher.emit("turn.start", publisher.createTurnId(), { input: "你好" });
  await new Promise<void>((resolve) => setImmediate(resolve));
});
