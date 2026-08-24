import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { emitEvent, initStore, readSnapshot } from "./project-events.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepo() {
  const cwd = mkdtempSync(path.join(tmpdir(), "dkagent-pm-"));
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Project Manager Test");
  git(cwd, "config", "user.email", "pm@example.test");
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Rules\n");
  git(cwd, "add", "AGENTS.md");
  git(cwd, "commit", "-m", "fixture");
  return cwd;
}

function started(overrides = {}) {
  return {
    taskId: "DKA-20260824-a1b2",
    action: "started",
    module: "agent",
    summary: "Implement event inbox",
    status: "in_progress",
    dependencies: [],
    evidence: [],
    discoveredTodos: [],
    ...overrides,
  };
}

test("init records the explicit main worktree", () => {
  const cwd = createRepo();
  const config = initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.deepEqual(config, { schemaVersion: 1, managementWorktree: cwd, managementBranch: "main" });
});

test("init rejects a main worktree from another repository", () => {
  const cwd = createRepo();
  const unrelated = createRepo();
  assert.throws(
    () => initStore({ cwd, managementWorktree: unrelated, managementBranch: "main" }),
    /management worktree does not share the Git common directory/,
  );
});

test("emit enriches and queues a strict event", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, event.eventId);
  assert.equal(snapshot.events[0].worktreePath, cwd);
  assert.equal(snapshot.events[0].branch, "main");
  assert.equal(snapshot.events[0].headSha, git(cwd, "rev-parse", "HEAD"));
});

test("emit rejects extra fields and unsupported completion", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.throws(() => emitEvent({ cwd, input: started({ rawLog: "secret" }) }), /unknown event field: rawLog/);
  assert.throws(
    () => emitEvent({ cwd, input: started({ discoveredTodos: [{ summary: "Follow up", module: "agent", reason: "Gap", rawLog: "secret" }] }) }),
    /unknown discovered todo field: rawLog/,
  );
  assert.throws(
    () => emitEvent({ cwd, input: started({ action: "finished", status: "completed" }) }),
    /completed code task requires successful behavioral evidence/,
  );
  assert.throws(
    () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", exitCode: 0, rawLog: "secret" }] }) }),
    /unknown evidence field: rawLog/,
  );
});

test("emit rejects unsafe or oversized persisted text", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.throws(
    () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command: "TOKEN=example-secret npm test", exitCode: 0 }] }) }),
    /unsafe text content/,
  );
  assert.throws(() => emitEvent({ cwd, input: started({ summary: "x".repeat(501) }) }), /text is too long/);
  assert.throws(
    () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command: "npm test\nnpm run typecheck", exitCode: 0 }] }) }),
    /command must be a single line/,
  );
});

test("completion requires complete execution evidence and accepts a successful command", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.throws(
    () => emitEvent({ cwd, input: started({ action: "finished", status: "completed", evidence: [{ kind: "test", summary: "pass", exitCode: 0 }] }) }),
    /evidence command is required/,
  );
  const event = emitEvent({
    cwd,
    input: started({
      action: "finished",
      status: "completed",
      evidence: [{ kind: "test", summary: "pass", command: "npm test", exitCode: 0 }],
    }),
  });
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, event.eventId);
});

test("emit rejects shell credentials but accepts a descriptive token summary", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const command of [
    "DATABASE_URL=postgres://db/app npm test",
    "NODE_ENV=test npm test",
    "export FOO=bar",
    "curl -H 'x-api-key: value' https://example.test",
    "curl -H 'api-key: value' https://example.test",
    "curl -H 'Authorization: Bearer value' https://example.test",
    "tool --api-key value",
    "tool --token value",
    "tool --password value",
    "tool --secret value",
    "curl https://user:password@example.test",
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command, exitCode: 0 }] }) }),
      /unsafe text content/,
    );
  }
  const event = emitEvent({ cwd, input: started({ summary: "Implement token: refresh strategy" }) });
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, event.eventId);
});
