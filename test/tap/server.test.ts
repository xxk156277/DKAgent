import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TapRecorder } from "../../src/tap/recorder.js";
import { startTapServer } from "../../src/tap/server.js";

test("提供 Viewer、历史事件和 SSE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dkagent-tap-server-"));
  const recorder = new TapRecorder(join(directory, "trace.jsonl"));
  const server = await startTapServer({ recorder, port: 0 });
  t.after(() => server.close());

  const html = await fetch(server.url).then((response) => response.text());
  assert.match(html, /DKAgent Tap/);
  assert.match(html, /context\.after/);

  const events = await fetch(`${server.url}api/events`).then((response) => response.json());
  assert.deepEqual(events, []);

  const controller = new AbortController();
  const streamResponse = await fetch(`${server.url}api/events/stream`, {
    signal: controller.signal,
  });
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
  controller.abort();
});
