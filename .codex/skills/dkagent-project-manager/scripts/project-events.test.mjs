import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  renderEventProjections,
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
  return realpathSync(cwd);
}

function started(overrides = {}) {
  return {
    taskId: "DKA-20260824-A1B2",
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

function renderTaskDocuments(cwd, token, events) {
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  const projections = renderEventProjections({ cwd, token, eventIds: events.map((event) => event.eventId) });
  writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${projections.blocks.map((item) => item.block).join("\n")}\n`);
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");
}

function writePendingEvent(cwd, event, createdAt) {
  const root = stateRoot(cwd);
  writeFileSync(
    path.join(root, "events", "pending", `${event.eventId}.json`),
    `${JSON.stringify({ ...event, createdAt }, null, 2)}\n`,
  );
}

function writeLifecycleIntent(cwd, name, pid) {
  writeFileSync(
    path.join(stateRoot(cwd), name),
    `${JSON.stringify({ operation: "recover", token: "00000000-0000-4000-8000-000000000000", pid, createdAt: "2026-08-24T00:00:00.000Z" })}\n`,
  );
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const helperPath = path.join(repositoryRoot, ".codex/skills/dkagent-project-manager/scripts/project-events.mjs");
const PROJECT_TASK_PREFIX_FOR_TEST = "- [project-task] ";

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

test("existing path aliases share one canonical state root and worktree identity", () => {
  const cwd = createRepo();
  const aliasRoot = mkdtempSync(path.join(tmpdir(), "dkagent-pm-alias-"));
  const alias = path.join(aliasRoot, "repo");
  symlinkSync(cwd, alias, "dir");
  const config = initStore({ cwd: alias, managementWorktree: cwd, managementBranch: "main" });
  assert.equal(stateRoot(alias), stateRoot(cwd));
  assert.equal(config.managementWorktree, cwd);
  assert.equal(emitEvent({ cwd: alias, input: started() }).worktreePath, cwd);
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

test("emit rejects extra fields", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  assert.throws(() => emitEvent({ cwd, input: started({ rawLog: "secret" }) }), /unknown event field: rawLog/);
  assert.throws(
    () => emitEvent({ cwd, input: started({ discoveredTodos: [{ summary: "Follow up", module: "agent", reason: "Gap", rawLog: "secret" }] }) }),
    /unknown discovered todo field: rawLog/,
  );
  assert.throws(
    () => emitEvent({ cwd, input: started({ evidence: [{ kind: "test", summary: "pass", exitCode: 0, rawLog: "secret" }] }) }),
    /unknown evidence field: rawLog/,
  );
});

test("emit requires canonical uppercase task IDs without surrounding whitespace", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const taskId of [" DKA-ABC", "DKA-ABC ", "dka-ABC", "DKA-abc", "DKA-AB", "DKA-AB_C"]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ taskId }) }),
      /taskId must use canonical format/,
    );
  }
  assert.throws(
    () => emitEvent({ cwd, input: started({ dependencies: ["DKA-invalid"] }) }),
    /dependency must use canonical format/,
  );
  assert.equal(emitEvent({ cwd, input: started({ taskId: "DKA-ABC", dependencies: ["DKA-DEPENDENCY"] }) }).taskId, "DKA-ABC");
});

test("emit downgrades unproved or failed completed events without losing finished action", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const inputs = [
    started({ action: "finished", status: "completed" }),
    started({
      action: "finished",
      status: "completed",
      evidence: [{ kind: "commit", summary: "commit abc123" }],
    }),
    started({
      action: "finished",
      status: "completed",
      evidence: [{ kind: "test", summary: "failed", command: "npm test", exitCode: 1 }],
    }),
  ];
  const events = inputs.map((input) => emitEvent({ cwd, input }));
  assert.deepEqual(events.map(({ action, status }) => ({ action, status })), [
    { action: "finished", status: "needs_verification" },
    { action: "finished", status: "needs_verification" },
    { action: "finished", status: "needs_verification" },
  ]);
  assert.deepEqual(readSnapshot({ cwd }).events.map((event) => event.status), [
    "needs_verification",
    "needs_verification",
    "needs_verification",
  ]);
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

test("emit accepts recognized commands with matching evidence kinds", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const evidenceItems = [
    { kind: "test", command: "npm test" },
    { kind: "test", command: "npm run test:project-manager" },
    { kind: "test", command: "node --test .codex/skills/dkagent-project-manager/scripts/project-events.test.mjs" },
    { kind: "test", command: "tsx --test scripts/project-events.test.mjs" },
    { kind: "test", command: "npx tsx --test scripts/project-events.test.mjs" },
    { kind: "typecheck", command: "npx tsc --noEmit" },
    { kind: "test", command: "npx vitest --run" },
    { kind: "build", command: "npm run build" },
  ];
  for (const evidence of evidenceItems) {
    emitEvent({ cwd, input: started({ evidence: [{ ...evidence, summary: "pass", exitCode: 0 }] }) });
  }
  assert.equal(readSnapshot({ cwd }).events.length, evidenceItems.length);
});

test("execution evidence kind must match the validation command", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const evidence of [
    { kind: "test", command: "npm run typecheck" },
    { kind: "typecheck", command: "npm test" },
    { kind: "build", command: "npm test" },
    { kind: "test", command: "git diff --check" },
    { kind: "test", command: "node --check scripts/project-events.mjs" },
    { kind: "test", command: "python3 scripts/quick_validate.py .codex/skills/dkagent-project-manager" },
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [{ ...evidence, summary: "pass", exitCode: 0 }] }) }),
      /evidence kind does not match command/,
    );
  }
  for (const evidence of [
    { kind: "test", command: "npm run test:project-manager" },
    { kind: "typecheck", command: "npm run typecheck" },
    { kind: "build", command: "npm run build" },
  ]) {
    emitEvent({ cwd, input: started({ evidence: [{ ...evidence, summary: "pass", exitCode: 0 }] }) });
  }
  assert.equal(readSnapshot({ cwd }).events.length, 3);
});

test("provenance and user confirmation cannot carry command exit semantics", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  for (const evidence of [
    { kind: "commit", summary: "commit abc123", exitCode: 0 },
    { kind: "user_confirmation", summary: "accepted", command: "npm test", exitCode: 0 },
    { kind: "user_confirmation", summary: "accepted", exitCode: 0 },
  ]) {
    assert.throws(
      () => emitEvent({ cwd, input: started({ evidence: [evidence] }) }),
      /non-execution evidence cannot contain command or exitCode/,
    );
  }
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

test("emit rejects multiline and Markdown-heading injection in every persisted free-text field", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const cases = [
    (value) => started({ taskId: value }),
    (value) => started({ module: value }),
    (value) => started({ summary: value }),
    (value) => started({ dependencies: [value] }),
    (value) => started({ evidence: [{ kind: "commit", summary: value }] }),
    (value) => started({ discoveredTodos: [{ summary: value, module: "agent", reason: "Gap" }] }),
    (value) => started({ discoveredTodos: [{ summary: "Follow up", module: value, reason: "Gap" }] }),
    (value) => started({ discoveredTodos: [{ summary: "Follow up", module: "agent", reason: value }] }),
  ];
  for (const createInput of cases) {
    for (const value of ["safe\n# injected", "safe\rinjected", "# injected heading"]) {
      assert.throws(
        () => emitEvent({ cwd, input: createInput(value) }),
        /must be a single line|Markdown heading/,
      );
    }
  }
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
  assert.deepEqual(snapshot.conflicts, [{
    kind: "task_claimed_by_multiple_worktrees",
    taskId: "DKA-20260824-A1B2",
    worktrees: [cwd, second].sort(),
  }]);
});

test("snapshot reports one worktree claiming two pending tasks", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  emitEvent({ cwd, input: started({ taskId: "DKA-WIP-FIRST" }) });
  emitEvent({ cwd, input: started({ taskId: "DKA-WIP-SECOND" }) });
  const token = acquireLock({ cwd }).token;
  assert.deepEqual(readSnapshot({ cwd, token }).conflicts, [{
    kind: "worktree_claims_multiple_tasks",
    worktreePath: cwd,
    taskIds: ["DKA-WIP-FIRST", "DKA-WIP-SECOND"],
  }]);
});

test("processed active claim still conflicts with a later worktree", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started() });
  const firstToken = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, firstToken, [first]);
  ackEvents({ cwd, token: firstToken, eventIds: [first.eventId], expectedDocumentHashes: documentHashes(cwd) });
  const second = `${cwd}-later`;
  git(cwd, "worktree", "add", "-b", "later", second);
  emitEvent({ cwd: second, input: started() });
  const token = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token }).conflicts[0].worktrees.length, 2);
});

test("processed active task conflicts with a second pending task in the same worktree", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-WIP-PROCESSED" }) });
  const firstToken = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, firstToken, [first]);
  ackEvents({ cwd, token: firstToken, eventIds: [first.eventId], expectedDocumentHashes: documentHashes(cwd) });
  emitEvent({ cwd, input: started({ taskId: "DKA-WIP-PENDING" }) });
  const token = acquireLock({ cwd }).token;
  assert.deepEqual(readSnapshot({ cwd, token }).conflicts, [{
    kind: "worktree_claims_multiple_tasks",
    worktreePath: cwd,
    taskIds: ["DKA-WIP-PENDING", "DKA-WIP-PROCESSED"],
  }]);
});

test("ack rejects two active tasks in one worktree and retains lock and events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-FIRST" }) });
  const second = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-SECOND" }) });
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [first, second]);
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [first.eventId, second.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /active claim conflicts block ACK/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 2);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
});

test("ack rejects one task active in two worktrees and retains lock and events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const secondWorktree = `${cwd}-ack-second`;
  git(cwd, "worktree", "add", "-b", "ack-second", secondWorktree);
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-SHARED" }) });
  const second = emitEvent({ cwd: secondWorktree, input: started({ taskId: first.taskId }) });
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [first, second]);
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [first.eventId, second.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /task_claimed_by_multiple_worktrees/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 2);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
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

test("projection helper emits canonical human and complete event records", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({
    cwd,
    input: started({
      taskId: "DKA-PROJECTION",
      summary: "Render complete facts",
      dependencies: ["DKA-DEPENDENCY"],
      evidence: [{ kind: "commit", summary: "commit abc123" }],
      discoveredTodos: [{ summary: "Follow up", module: "trace", reason: "Coverage gap" }],
    }),
  });
  const token = acquireLock({ cwd }).token;
  const result = renderEventProjections({ cwd, token, eventIds: [event.eventId] });
  assert.equal(result.blocks.length, 1);
  const [block] = result.blocks;
  assert.equal(block.taskLine, `- [project-task] ${JSON.stringify({
    taskId: event.taskId,
    status: event.status,
    module: event.module,
    summary: event.summary,
    worktreePath: event.worktreePath,
    branch: event.branch,
    headSha: event.headSha,
    createdAt: event.createdAt,
  })}`);
  const record = JSON.parse(block.projectionLine.slice("- [project-event] ".length));
  assert.deepEqual(record.payload, event);
  assert.equal(record.digest, createHash("sha256").update(JSON.stringify(record.payload)).digest("hex"));
  assert.equal(block.block, `${block.taskLine}\n${block.projectionLine}`);
  releaseLock({ cwd, token });
});

test("CLI project emits the same canonical projection block", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-CLI-PROJECTION" }) });
  const token = acquireLock({ cwd }).token;
  const expected = renderEventProjections({ cwd, token, eventIds: [event.eventId] });
  const result = spawnSync(
    process.execPath,
    [helperPath, "project", "--token", token, "--event-ids", event.eventId],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expected);
  releaseLock({ cwd, token });
});

test("ack rejects projections with missing source facts or a forged HEAD", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-SOURCE-BOUND" }) });
  const token = acquireLock({ cwd }).token;
  const [valid] = renderEventProjections({ cwd, token, eventIds: [event.eventId] }).blocks;
  const human = JSON.parse(valid.taskLine.slice(PROJECT_TASK_PREFIX_FOR_TEST.length));
  const record = JSON.parse(valid.projectionLine.slice("- [project-event] ".length));
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");

  for (const field of ["schemaVersion", "worktreePath", "branch", "headSha", "createdAt"]) {
    const payload = structuredClone(record.payload);
    delete payload[field];
    const projectionLine = `- [project-event] ${JSON.stringify({
      digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      payload,
    })}`;
    writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${valid.taskLine}\n${projectionLine}\n`);
    assert.throws(
      () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /event is not canonically projected/,
    );
  }

  for (const field of ["worktreePath", "branch", "headSha", "createdAt"]) {
    const incompleteHuman = structuredClone(human);
    delete incompleteHuman[field];
    writeFileSync(
      path.join(cwd, "docs", "project", "STATUS.md"),
      `# Status\n\n${PROJECT_TASK_PREFIX_FOR_TEST}${JSON.stringify(incompleteHuman)}\n${valid.projectionLine}\n`,
    );
    assert.throws(
      () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /event is not canonically projected/,
    );
  }

  const forgedHuman = { ...human, headSha: "0".repeat(40) };
  const forgedPayload = { ...record.payload, headSha: forgedHuman.headSha };
  const forgedProjectionLine = `- [project-event] ${JSON.stringify({
    digest: createHash("sha256").update(JSON.stringify(forgedPayload)).digest("hex"),
    payload: forgedPayload,
  })}`;
  writeFileSync(
    path.join(cwd, "docs", "project", "STATUS.md"),
    `# Status\n\n${PROJECT_TASK_PREFIX_FOR_TEST}${JSON.stringify(forgedHuman)}\n${forgedProjectionLine}\n`,
  );
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("projection helper rejects stored events with incomplete source facts", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-STORED-SOURCE" }) });
  const token = acquireLock({ cwd }).token;
  const eventFile = path.join(stateRoot(cwd), "events", "pending", `${event.eventId}.json`);
  for (const field of ["schemaVersion", "worktreePath", "branch", "headSha", "createdAt"]) {
    const incomplete = structuredClone(event);
    delete incomplete[field];
    writeFileSync(eventFile, `${JSON.stringify(incomplete)}\n`);
    assert.throws(
      () => renderEventProjections({ cwd, token, eventIds: [event.eventId] }),
      /invalid stored event/,
    );
  }
  releaseLock({ cwd, token });
});

test("ack accepts the locked writer changes and is idempotent", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  assert.equal(readSnapshot({ cwd, token }).target.safe, true);
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Aggregated rules\n");
  renderTaskDocuments(cwd, token, [event]);
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
  renderTaskDocuments(cwd, token, [event]);
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
  const projection = renderEventProjections({
    cwd,
    token,
    eventIds: [last.eventId, first.eventId, finished.eventId],
  });
  assert.equal(projection.blocks.length, 1);
  assert.equal(projection.blocks[0].eventId, last.eventId);
  renderTaskDocuments(cwd, token, [last, first, finished]);
  ackEvents({
    cwd,
    token,
    eventIds: [last.eventId, first.eventId, finished.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });
  const snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.state.activeClaims, { [first.taskId]: [cwd] });
  assert.deepEqual(snapshot.state.processedEventIds, [first.eventId, finished.eventId, last.eventId]);
  for (const event of [first, finished, last]) {
    assert.equal(existsSync(path.join(stateRoot(cwd), "events", "processed", `${event.eventId}.json`)), true);
  }
  const status = readFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "utf8");
  assert.equal(status.split(/\r?\n/).filter((line) => line.startsWith("- [project-event] ")).length, 1);
  assert.match(status, new RegExp(last.eventId));
});

test("ack rejects a selected task when event IDs omit one of its pending events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-PARTIAL-ACK" }) });
  emitEvent({
    cwd,
    input: started({
      taskId: first.taskId,
      action: "finished",
      status: "needs_verification",
      summary: "Finished after the selected start",
    }),
  });
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [first]);
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [first.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event IDs must include all pending events for selected task/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 2);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
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

test("ack rejects a finished event when documents retain only its started projection", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-STALE-STATUS" }) });
  const finished = emitEvent({
    cwd,
    input: started({
      taskId: first.taskId,
      action: "finished",
      status: "needs_verification",
      summary: "Implementation finished but needs verification",
    }),
  });
  const token = acquireLock({ cwd }).token;
  const projection = renderEventProjections({ cwd, token, eventIds: [first.eventId] });
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${projection.blocks[0].block}\n`);
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [first.eventId, finished.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 2);
  releaseLock({ cwd, token });
});

test("finished ACK replaces the started current projection while processed events retain both facts", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const startedEvent = emitEvent({ cwd, input: started({ taskId: "DKA-STATE-EVOLUTION" }) });
  const startedToken = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, startedToken, [startedEvent]);
  ackEvents({
    cwd,
    token: startedToken,
    eventIds: [startedEvent.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  const finishedEvent = emitEvent({
    cwd,
    input: started({
      taskId: startedEvent.taskId,
      action: "finished",
      status: "needs_verification",
      summary: "Implementation finished and awaits verification",
    }),
  });
  const finishedToken = acquireLock({ cwd }).token;
  const [finishedProjection] = renderEventProjections({
    cwd,
    token: finishedToken,
    eventIds: [finishedEvent.eventId],
  }).blocks;
  const staleStatus = readFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "utf8");
  writeFileSync(
    path.join(cwd, "docs", "project", "STATUS.md"),
    `${staleStatus.trimEnd()}\n${finishedProjection.block}\n`,
  );
  assert.throws(
    () => ackEvents({
      cwd,
      token: finishedToken,
      eventIds: [finishedEvent.eventId],
      expectedDocumentHashes: documentHashes(cwd),
    }),
    /exactly one current projection/,
  );
  assert.equal(readSnapshot({ cwd, token: finishedToken }).events.length, 1);
  renderTaskDocuments(cwd, finishedToken, [finishedEvent]);
  ackEvents({
    cwd,
    token: finishedToken,
    eventIds: [finishedEvent.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  const currentStatus = readFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "utf8");
  assert.doesNotMatch(currentStatus, new RegExp(startedEvent.eventId));
  assert.doesNotMatch(currentStatus, /"status":"in_progress"/);
  assert.match(currentStatus, new RegExp(finishedEvent.eventId));
  assert.match(currentStatus, /"status":"needs_verification"/);

  const root = stateRoot(cwd);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "events", "processed", `${startedEvent.eventId}.json`), "utf8")),
    startedEvent,
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(root, "events", "processed", `${finishedEvent.eventId}.json`), "utf8")),
    finishedEvent,
  );
  assert.deepEqual(readSnapshot({ cwd }).state.processedEventIds.sort(), [startedEvent.eventId, finishedEvent.eventId].sort());
});

test("ack rejects mismatched human facts and incomplete canonical payloads", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({
    cwd,
    input: started({
      taskId: "DKA-ACK-COMPLETE",
      summary: "Preserve complete event facts",
      dependencies: ["DKA-DEPENDENCY"],
      evidence: [{ kind: "commit", summary: "commit abc123" }],
      discoveredTodos: [{ summary: "Follow up", module: "trace", reason: "Coverage gap" }],
    }),
  });
  const token = acquireLock({ cwd }).token;
  const [valid] = renderEventProjections({ cwd, token, eventIds: [event.eventId] }).blocks;
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");
  const human = JSON.parse(valid.taskLine.slice(PROJECT_TASK_PREFIX_FOR_TEST.length));
  for (const patch of [
    { status: "needs_verification" },
    { module: "trace" },
    { summary: "Stale summary" },
  ]) {
    const taskLine = `${PROJECT_TASK_PREFIX_FOR_TEST}${JSON.stringify({ ...human, ...patch })}`;
    writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${taskLine}\n${valid.projectionLine}\n`);
    assert.throws(
      () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /event is not canonically projected/,
    );
  }
  const record = JSON.parse(valid.projectionLine.slice("- [project-event] ".length));
  for (const payload of [
    { ...record.payload, action: "discovered" },
    { ...record.payload, dependencies: [] },
    { ...record.payload, evidence: [] },
    { ...record.payload, discoveredTodos: [] },
  ]) {
    const projectionLine = `- [project-event] ${JSON.stringify({
      digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      payload,
    })}`;
    writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${valid.taskLine}\n${projectionLine}\n`);
    assert.throws(
      () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /event is not canonically projected/,
    );
  }
  writeFileSync(
    path.join(cwd, "docs", "project", "STATUS.md"),
    `# Status\n\n${valid.taskLine}\nintervening prose\n${valid.projectionLine}\n`,
  );
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("ack rejects task IDs mentioned only in comments or prose", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n<!-- ${event.taskId} -->\n\nMention ${event.taskId} in prose.\n`);
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("ack rejects duplicate current projections in one or both management documents", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-DUPLICATE-CURRENT" }) });
  const token = acquireLock({ cwd }).token;
  const [projection] = renderEventProjections({ cwd, token, eventIds: [event.eventId] }).blocks;
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });

  for (const [status, backlog] of [
    [`# Status\n\n${projection.block}\n${projection.block}\n`, "# Backlog\n"],
    [`# Status\n\n${projection.block}\n`, `# Backlog\n\n${projection.block}\n`],
  ]) {
    writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), status);
    writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), backlog);
    assert.throws(
      () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /exactly one current projection/,
    );
  }
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
});

test("ack rejects title-only management documents", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "# Rendered status\n");
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Rendered backlog\n");
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("ack rejects a structured STATUS task with an empty human summary", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  mkdirSync(path.join(cwd, "docs", "project"), { recursive: true });
  const [valid] = renderEventProjections({ cwd, token, eventIds: [event.eventId] }).blocks;
  const marker = `${PROJECT_TASK_PREFIX_FOR_TEST}${JSON.stringify({
    taskId: event.taskId,
    status: event.status,
    module: event.module,
    summary: "",
  })}`;
  writeFileSync(path.join(cwd, "docs", "project", "STATUS.md"), `# Status\n\n${marker}\n${valid.projectionLine}\n`);
  writeFileSync(path.join(cwd, "docs", "project", "BACKLOG.md"), "# Backlog\n");
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event is not canonically projected/,
  );
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("ack rejects an empty event ID list", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const token = acquireLock({ cwd }).token;
  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [], expectedDocumentHashes: documentHashes(cwd) }),
    /invalid event ID/,
  );
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

test("an owned tombstone blocks another aggregator from acquiring the lock", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const tombstone = "aggregate.lock.recovery-retained-owner";
  const owner = acquireLock({ cwd });
  renameSync(path.join(root, "aggregate.lock"), path.join(root, tombstone));
  const status = lockStatus({ cwd });
  assert.deepEqual(status.blockingTombstones, [tombstone]);
  assert.throws(() => acquireLock({ cwd }), /owned recovery tombstone/);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /owned recovery tombstone/);
  assert.ok(existsSync(path.join(root, tombstone)));
  assert.equal(owner.token.length, 36);
});

test("published lock files expose a complete owner and require token release", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const owner = acquireLock({ cwd });
  const root = stateRoot(cwd);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "aggregate.lock"), "utf8")), owner);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /release requires token/);
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
});

test("CLI owner token is recovered from lock status after its process exits", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const acquired = spawnSync(process.execPath, [helperPath, "acquire-lock"], { cwd, encoding: "utf8" });
  assert.equal(acquired.status, 0, acquired.stderr);
  const owner = JSON.parse(acquired.stdout);
  assert.notEqual(owner.pid, process.pid);
  const status = lockStatus({ cwd });
  assert.equal(status.recoverable, false);
  assert.equal(status.owner.token, owner.token);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /owner exists; release requires token/);
  assert.equal(releaseLock({ cwd, token: status.owner.token }), true);
  assert.equal(lockStatus({ cwd }).held, false);
});

test("release intent blocks acquires before and after the current lock is removed", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const owner = acquireLock({ cwd });
  const intent = path.join(root, "aggregate.intent-release-test");
  mkdirSync(intent);
  assert.throws(() => acquireLock({ cwd }), /lifecycle operation is in progress/);
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
  assert.throws(() => acquireLock({ cwd }), /lifecycle operation is in progress/);
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, ["aggregate.intent-release-test"]);
  assert.equal(recoverLock({ cwd, confirm: true }), true);
  assert.ok(acquireLock({ cwd }).token);
});

test("dead recovery intent and a legacy lock converge on explicit recovery", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const lock = path.join(root, "aggregate.lock");
  mkdirSync(lock);
  writeLifecycleIntent(cwd, "aggregate.intent-recover-dead", 999999999);
  assert.equal(recoverLock({ cwd, confirm: true }), true);
  assert.equal(existsSync(lock), false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("live lifecycle intent blocks recovery of an invalid lock", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const lock = path.join(root, "aggregate.lock");
  mkdirSync(lock);
  writeLifecycleIntent(cwd, "aggregate.intent-recover-live", process.pid);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /lifecycle operation is in progress/);
  assert.ok(existsSync(lock));
});

test("a normal owner prevents stale intent cleanup", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const owner = acquireLock({ cwd });
  const intent = "aggregate.intent-recover-dead";
  writeLifecycleIntent(cwd, intent, 999999999);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /release requires token/);
  assert.ok(lockStatus({ cwd }).intentMarkers.includes(intent));
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
});

test("three worktrees render the management documents before ACKing exact hashes", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const worktrees = [
    ["agent", "agent"],
    ["trace", "trace"],
    ["web", "web-tap"],
  ].map(([name, module]) => {
    const worker = `${cwd}-${name}`;
    git(cwd, "worktree", "add", "-b", `${name}-task`, worker);
    return { worker, module };
  });
  for (const { worker, module } of worktrees) {
    emitEvent({
      cwd: worker,
      input: started({
        taskId: `DKA-SMOKE-${module.toUpperCase()}`,
        module,
        summary: `Start ${module} smoke task`,
        dependencies: [`DKA-DEPENDENCY-${module.toUpperCase()}`],
        evidence: [{ kind: "commit", summary: `${module} fixture commit` }],
        discoveredTodos: [{ summary: `${module} follow up`, module, reason: "Fixture coverage" }],
      }),
    });
  }

  const token = acquireLock({ cwd }).token;
  const snapshot = readSnapshot({ cwd, token });
  assert.equal(snapshot.events.length, 3);
  assert.equal(new Set(snapshot.events.map((event) => event.worktreePath)).size, 3);
  assert.deepEqual(snapshot.conflicts, []);

  writeFileSync(path.join(cwd, "AGENTS.md"), "# DKAgent Agent Instructions\n");
  renderTaskDocuments(cwd, token, snapshot.events);
  const renderedStatus = readFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "utf8");
  for (const event of snapshot.events) {
    assert.match(renderedStatus, new RegExp(event.taskId));
    assert.match(renderedStatus, new RegExp(event.status));
    assert.match(renderedStatus, new RegExp(`"evidence":\\[${event.evidence.length ? ".+" : ""}\\]`));
  }
  ackEvents({
    cwd,
    token,
    eventIds: snapshot.events.map((event) => event.eventId),
    expectedDocumentHashes: documentHashes(cwd),
  });

  const acknowledged = readSnapshot({ cwd });
  assert.equal(acknowledged.events.length, 0);
  assert.deepEqual(acknowledged.state.documentHashes, documentHashes(cwd));
  const retainedRecords = readFileSync(path.join(cwd, "docs", "project", "STATUS.md"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- [project-event] "))
    .map((line) => JSON.parse(line.slice("- [project-event] ".length)).payload);
  for (const event of snapshot.events) {
    assert.deepEqual(retainedRecords.find((payload) => payload.eventId === event.eventId), event);
  }
});

test("a pending worker event survives removal of its worktree", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const worker = `${cwd}-removed-worker`;
  git(cwd, "worktree", "add", "-b", "removed-worker", worker);
  const event = emitEvent({ cwd: worker, input: started({ taskId: "DKA-SMOKE-REMOVED" }) });

  git(cwd, "worktree", "remove", "--force", worker);

  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, event.eventId);
  assert.equal(snapshot.events[0].worktreePath, worker);
});

test("CLI ACK accepts rendered hashes from the invoking worktree and clears pending events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Rendered rules\n");
  renderTaskDocuments(cwd, token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const hashesFile = path.join(cwd, "expected-hashes.json");
  writeFileSync(hashesFile, `${JSON.stringify(expectedDocumentHashes)}\n`);

  let result;
  try {
    result = spawnSync(
      process.execPath,
      [helperPath, "ack", "--token", token, "--event-ids", event.eventId, "--expected-hashes-file", hashesFile],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).documentHashes, expectedDocumentHashes);
  } finally {
    if (existsSync(hashesFile)) unlinkSync(hashesFile);
  }

  assert.equal(existsSync(hashesFile), false);
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.events.length, 0);
  assert.deepEqual(snapshot.state.documentHashes, expectedDocumentHashes);
});

test("CLI ACK rejects expected-hash files outside cwd, including symlink escapes", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started() });
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [event]);
  const outsideDirectory = mkdtempSync(path.join(tmpdir(), "dkagent-pm-hashes-"));
  const outsideFile = path.join(outsideDirectory, "expected-hashes.json");
  writeFileSync(outsideFile, `${JSON.stringify(documentHashes(cwd))}\n`);
  const link = path.join(cwd, "expected-hashes-link.json");
  symlinkSync(outsideFile, link);
  for (const hashesFile of [outsideFile, link]) {
    const result = spawnSync(
      process.execPath,
      [helperPath, "ack", "--token", token, "--event-ids", event.eventId, "--expected-hashes-file", hashesFile],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected hashes file must be a JSON file inside cwd/);
  }
  assert.equal(readSnapshot({ cwd, token }).events.length, 1);
  releaseLock({ cwd, token });
});

test("activated project-management documents and Skill describe the hash-checked ACK workflow", () => {
  for (const relative of ["AGENTS.md", "docs/project/STATUS.md", "docs/project/BACKLOG.md"]) {
    assert.equal(existsSync(path.join(repositoryRoot, relative)), true, `${relative} must be activated`);
  }
  const skill = readFileSync(path.join(repositoryRoot, ".codex/skills/dkagent-project-manager/SKILL.md"), "utf8");
  assert.match(skill, /--expected-hashes-file/);
  assert.match(skill, /`snapshot` 的 `target\.managementWorktree`/);
  assert.match(skill, /lock-status/);
  assert.match(skill, /recover-lock --confirm/);
  assert.match(skill, /`conflicts` 非空/);
  assert.match(skill, /owner\.token/);
  assert.match(skill, /project --token/);
  assert.match(skill, /replace that task's previous block with the latest block/i);
  assert.match(skill, /schema version.*canonical worktree.*branch.*HEAD.*creation time/);
  assert.match(skill, /sorts by.*createdAt.*eventId.*folds by taskId/);
  assert.match(skill, /all pending events for every selected task/);
  const contracts = readFileSync(path.join(repositoryRoot, ".codex/skills/dkagent-project-manager/references/document-contracts.md"), "utf8");
  assert.match(contracts, /- \[project-task\]/);
  assert.match(contracts, /- \[project-event\]/);
  assert.match(contracts, /eventId.*dependencies.*evidence.*discoveredTodos/);
  assert.match(contracts, /schemaVersion.*worktreePath.*branch.*headSha.*createdAt/);
  assert.match(contracts, /worktree_claims_multiple_tasks/);
  assert.match(contracts, /ACK independently recomputes both conflict kinds/);
  assert.match(contracts, /\^DKA-\[A-Z0-9\]/);
  assert.match(contracts, /current projection.*latest event/);
  assert.match(contracts, /processed event JSON.*audit history/);
  assert.match(contracts, /ACK sort requested events by.*createdAt.*eventId/);
  assert.match(contracts, /exactly one current block across STATUS and BACKLOG/);
  assert.match(contracts, /include all pending events for each selected task/);
  assert.match(contracts, /git diff --check.*cannot/);
  assert.match(contracts, /deterministically downgrades.*`needs_verification`/);
  const report = readFileSync(path.join(repositoryRoot, ".superpowers/sdd/final-fix-report.md"), "utf8");
  assert.doesNotMatch(report, /owner PID.*ESRCH/);
  assert.match(report, /canonical event projection/);
  assert.match(report, /latest current projection/);
  assert.match(report, /folded latest projection/);
});
