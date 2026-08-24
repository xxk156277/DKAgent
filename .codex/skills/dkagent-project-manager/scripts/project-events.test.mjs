import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireLock,
  ackEvents,
  adoptDocuments,
  emitEvent,
  initStore,
  lockStatus,
  readSnapshot,
  recoverLock,
  releaseLock,
  stateRoot,
} from "./project-events.mjs";

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

function documentHashes(cwd) {
  return Object.fromEntries([
    "AGENTS.md",
    "docs/project/STATUS.md",
    "docs/project/BACKLOG.md",
  ].map((relative) => {
    const file = path.join(cwd, relative);
    return [relative, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null];
  }));
}

function writePendingEvent(cwd, event, createdAt) {
  const root = stateRoot(cwd);
  writeFileSync(
    path.join(root, "events", "pending", `${event.eventId}.json`),
    `${JSON.stringify({ ...event, createdAt }, null, 2)}\n`,
  );
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
    "env -i FOO=bar npm test",
    "env --unset FOO BAR=bar npm test",
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

test("emit only accepts one simple command with safe arguments", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const command of [
    "npm test && npm run typecheck",
    "echo $(whoami)",
    "(DATABASE_URL=postgres://db/app npm test)",
    "curl https://token@example.test",
    "curl https://:password@example.test",
    "tool --authorization value",
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command, exitCode: 0 }] }) }),
      /unsafe text content/,
    );
  }
  const event = emitEvent({
    cwd,
    input: started({ evidence: [{ kind: "test", summary: "pass", command: "node --test .codex/skills/dkagent-project-manager/scripts/project-events.test.mjs", exitCode: 0 }] }),
  });
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, event.eventId);
});

test("emit rejects shell wrappers and non-whitelisted executables", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const command of [
    "npm test & DATABASE_URL=postgres://db/app",
    "bash -c 'DATABASE_URL=postgres://db/app npm test'",
    "node -e process.exit(0)",
    "python3 -c pass",
    "npm exec vitest",
    "curl https://example.test",
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command, exitCode: 0 }] }) }),
      /unsafe text content/,
    );
  }
});

test("emit accepts only whitelisted verification commands", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const commands = [
    "npm test",
    "npm run test:project-manager",
    "node --test .codex/skills/dkagent-project-manager/scripts/project-events.test.mjs",
    "node --check scripts/project-events.mjs",
    "git diff --check",
    "python3 scripts/quick_validate.py .codex/skills/dkagent-project-manager",
    "tsx --test scripts/project-events.test.mjs",
    "npx tsx --test scripts/project-events.test.mjs",
    "npx tsc --noEmit",
    "npx vitest --run",
  ];
  for (const command of commands) {
    emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command, exitCode: 0 }] }) });
  }
  assert.equal(readSnapshot({ cwd }).events.length, commands.length);
});

test("emit rejects environment assignments hidden in allowed command arguments", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const command of [
    "npm run test:project-manager -- DATABASE_URL=postgres://db/app",
    "node --test --test-reporter-destination=DATABASE_URL=postgres://db/app",
    "npx vitest --run --config=DATABASE_URL=postgres://db/app",
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", command, exitCode: 0 }] }) }),
      /unsafe text content/,
    );
  }
});

test("emit rejects high-confidence credentials in persisted free text", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.throws(
    () => emitEvent({ cwd, input: started({ summary: "verified https://example-token@example.test" }) }),
    /unsafe text content/,
  );
  assert.throws(
    () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "x-api-key: example-value", command: "npm test", exitCode: 0 }] }) }),
    /unsafe text content/,
  );
  assert.throws(
    () => emitEvent({ cwd, input: started({ discoveredTodos: [{ summary: "Follow up", module: "agent", reason: "Authorization: Bearer example-value" }] }) }),
    /unsafe text content/,
  );
});

test("only one aggregator holds the lock", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = acquireLock({ cwd });
  assert.throws(() => acquireLock({ cwd }), /aggregate lock is held/);
  assert.equal(releaseLock({ cwd, token: first.token }), true);
  assert.ok(acquireLock({ cwd }).token);
});

test("snapshot reports one task claimed by two worktrees", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const second = `${cwd}-second`;
  git(cwd, "worktree", "add", "-b", "second", second);
  emitEvent({ cwd, input: started() });
  emitEvent({ cwd: second, input: started() });
  const token = acquireLock({ cwd }).token;
  const snapshot = readSnapshot({ cwd, token });
  assert.equal(snapshot.conflicts[0].taskId, "DKA-20260824-a1b2");
  assert.equal(snapshot.conflicts[0].worktrees.length, 2);
});

test("processed active claim still conflicts with a later worktree", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started() });
  const firstToken = acquireLock({ cwd }).token;
  ackEvents({ cwd, token: firstToken, eventIds: [first.eventId], expectedDocumentHashes: documentHashes(cwd) });
  const second = `${cwd}-later`;
  git(cwd, "worktree", "add", "-b", "later", second);
  emitEvent({ cwd: second, input: started() });
  const token = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token }).conflicts[0].worktrees.length, 2);
});

test("external document edit requires explicit adoption", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Human edit\n");
  const token = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token }).target.safe, false);
  adoptDocuments({ cwd, token });
  const next = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token: next }).target.safe, true);
});

test("adopt rejects management branch drift and retains the lock", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  git(cwd, "switch", "-c", "adoption-drift");
  const token = acquireLock({ cwd }).token;
  assert.throws(() => adoptDocuments({ cwd, token }), /management branch mismatch/);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  assert.equal(releaseLock({ cwd, token }), true);
});

test("management branch drift blocks aggregation", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  git(cwd, "switch", "-c", "feature");
  const token = acquireLock({ cwd }).token;
  const target = readSnapshot({ cwd, token }).target;
  assert.equal(target.safe, false);
  assert.match(target.reasons.join(" "), /management branch mismatch/);
});

test("ack accepts the locked writer changes and is idempotent", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token }).target.safe, true);
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Aggregated rules\n");
  ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) });
  const repeatedToken = acquireLock({ cwd }).token;
  ackEvents({ cwd, token: repeatedToken, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) });
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 0);
  assert.ok(snapshot.state.processedEventIds.includes(event.eventId));
});

test("ack repairs an event moved before state persistence", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const root = stateRoot(cwd);
  renameSync(
    path.join(root, "events", "pending", `${event.eventId}.json`),
    path.join(root, "events", "processed", `${event.eventId}.json`),
  );
  const token = acquireLock({ cwd }).token;
  ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) });
  assert.ok(readSnapshot({ cwd }).state.processedEventIds.includes(event.eventId));
});

test("ack replays processed events in creation order instead of input order", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started() });
  const finished = emitEvent({ cwd, input: started({ action: "finished", status: "needs_verification" }) });
  const last = emitEvent({ cwd, input: started() });
  writePendingEvent(cwd, first, "2026-08-24T00:00:00.000Z");
  writePendingEvent(cwd, finished, "2026-08-24T00:00:01.000Z");
  writePendingEvent(cwd, last, "2026-08-24T00:00:02.000Z");
  const token = acquireLock({ cwd }).token;
  ackEvents({
    cwd,
    token,
    eventIds: [last.eventId, first.eventId, finished.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });
  assert.deepEqual(readSnapshot({ cwd }).state.activeClaims, { [first.taskId]: [cwd] });
});

test("ack rejects external document drift that differs from rendered hashes", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Human drift\n");
  const expectedDocumentHashes = documentHashes(cwd);
  expectedDocumentHashes["AGENTS.md"] = createHash("sha256").update("# Rendered rules\n").digest("hex");
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes }),
    /management document hashes do not match expected results/,
  );
  const snapshot = readSnapshot({ cwd, token });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.state.processedEventIds.length, 0);
  releaseLock({ cwd, token });
});

test("ack rejects an invalid event ID without changing state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const token = acquireLock({ cwd }).token;
  const before = readSnapshot({ cwd, token }).state;
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: ["../../config"], expectedDocumentHashes: documentHashes(cwd) }),
    /invalid event ID/,
  );
  assert.deepEqual(readSnapshot({ cwd, token }).state, before);
  assert.ok(existsSync(path.join(stateRoot(cwd), "config.json")));
  releaseLock({ cwd, token });
});

test("half-created locks are diagnosable and require explicit recovery", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  mkdirSync(path.join(root, "aggregate.lock"));
  assert.deepEqual(lockStatus({ cwd }), { held: true, recoverable: true, owner: null, recoveryTombstones: [] });
  assert.throws(() => recoverLock({ cwd }), /lock recovery requires explicit confirmation/);
  assert.equal(recoverLock({ cwd, confirm: true }), true);
  assert.ok(acquireLock({ cwd }).token);
});

test("a later recovery cannot delete a lock acquired after abandoned recovery", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  mkdirSync(path.join(stateRoot(cwd), "aggregate.lock"));
  assert.equal(recoverLock({ cwd, confirm: true }), true);
  const owner = acquireLock({ cwd });
  assert.equal(lockStatus({ cwd }).recoverable, false);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /release requires token/);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
});

test("lock status retains an owned tombstone without deleting a later new lock", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const tombstone = "aggregate.lock.recovery-retained-owner";
  mkdirSync(path.join(root, tombstone));
  writeFileSync(path.join(root, tombstone, "owner.json"), "{\"token\":\"old-owner\"}\n");
  assert.deepEqual(lockStatus({ cwd }), {
    held: false,
    recoverable: false,
    owner: null,
    recoveryTombstones: [tombstone],
  });
  const owner = acquireLock({ cwd });
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.deepEqual(lockStatus({ cwd }).recoveryTombstones, [tombstone]);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /release requires token/);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
});
