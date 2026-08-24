import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  recoverAckCleanup,
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

function writeAckLifecycleIntent(cwd, name, {
  pid,
  lockToken,
  eventIds,
  expectedDocumentHashes,
  operation = "ack",
  includeLockToken = true,
}) {
  writeFileSync(
    path.join(stateRoot(cwd), name),
    `${JSON.stringify({
      operation,
      token: "00000000-0000-4000-8000-000000000000",
      pid,
      createdAt: "2026-08-24T00:00:00.000Z",
      ...(includeLockToken ? { lockToken } : {}),
      ...(operation === "ack" ? { eventIds: [...eventIds].sort(), expectedDocumentHashes } : {}),
    })}\n`,
  );
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const helperPath = path.join(repositoryRoot, ".codex/skills/dkagent-project-manager/scripts/project-events.mjs");
const helperUrl = new URL("./project-events.mjs", import.meta.url).href;
const PROJECT_TASK_PREFIX_FOR_TEST = "- [project-task] ";

function runCrashingAck({ cwd, token, eventIds, expectedDocumentHashes, phase, signal = "exit" }) {
  const source = `
    import { ackEvents } from ${JSON.stringify(helperUrl)};
    const input = JSON.parse(process.env.DKA_TEST_ACK_INPUT);
    ackEvents({ ...input, _testTerminateAfterPhase: ${JSON.stringify(phase)}, _testTerminationSignal: ${JSON.stringify(signal)} });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      DKA_TEST_ACK_INPUT: JSON.stringify({ cwd, token, eventIds, expectedDocumentHashes }),
    },
  });
}

function runAckProcess({ cwd, token, eventIds, expectedDocumentHashes }) {
  const source = `
    import { ackEvents } from ${JSON.stringify(helperUrl)};
    ackEvents(JSON.parse(process.env.DKA_TEST_ACK_INPUT));
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd,
      env: {
        ...process.env,
        DKA_TEST_ACK_INPUT: JSON.stringify({ cwd, token, eventIds, expectedDocumentHashes }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
  });
}

function runCrashingAckCleanup({ cwd, signal = "SIGKILL" }) {
  const source = `
    import { recoverAckCleanup } from ${JSON.stringify(helperUrl)};
    recoverAckCleanup({ cwd: process.cwd(), confirm: true, _testTerminateAfterRenameCount: 1, _testTerminationSignal: ${JSON.stringify(signal)} });
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd,
    encoding: "utf8",
  });
}

function createTerminalCleanupFixture(taskId) {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
    phase: "owner",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  return { cwd, event, root: stateRoot(cwd) };
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

test("adopt lifecycle excludes ACK, acquire, release, and recover until owner deletion", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ADOPT-LIFECYCLE" }) });
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Adopted edit\n");
  const owner = acquireLock({ cwd });
  let checked = false;

  adoptDocuments({
    cwd,
    token: owner.token,
    _testAfterLifecycleAcquired() {
      checked = true;
      const status = lockStatus({ cwd });
      assert.equal(status.lifecycleIntents.length, 1);
      assert.deepEqual(
        {
          operation: status.lifecycleIntents[0].operation,
          lockToken: status.lifecycleIntents[0].lockToken,
          processAlive: status.lifecycleIntents[0].processAlive,
        },
        { operation: "adopt", lockToken: owner.token, processAlive: true },
      );
      assert.throws(
        () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
        /lifecycle operation is in progress/,
      );
      assert.throws(() => acquireLock({ cwd }), /lifecycle operation is in progress/);
      assert.throws(() => releaseLock({ cwd, token: owner.token }), /lifecycle operation is in progress/);
      assert.throws(() => recoverLock({ cwd, confirm: true }), /lifecycle operation is in progress/);
    },
  });

  assert.equal(checked, true);
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("adopt refuses an unfinished ACK intent before changing state or owner", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ADOPT-ACK-INTENT" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const root = stateRoot(cwd);
  const beforeState = readFileSync(path.join(root, "state.json"), "utf8");

  assert.throws(
    () => adoptDocuments({ cwd, token: owner.token }),
    /ACK intent must be completed before adopting documents/,
  );
  assert.equal(readFileSync(path.join(root, "state.json"), "utf8"), beforeState);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
});

test("adopt revalidates its owner before writing adopted hashes", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  writeFileSync(path.join(cwd, "AGENTS.md"), "# Owner recheck edit\n");
  const owner = acquireLock({ cwd });
  const root = stateRoot(cwd);
  const beforeState = readFileSync(path.join(root, "state.json"), "utf8");
  const replacement = { ...owner, token: "00000000-0000-4000-8000-000000000001" };

  assert.throws(
    () => adoptDocuments({
      cwd,
      token: owner.token,
      _testBeforeStateWrite() {
        writeFileSync(
          path.join(root, "aggregate.lock"),
          `${JSON.stringify(replacement, null, 2)}\n`,
        );
      },
    }),
    /aggregate lock token mismatch/,
  );
  assert.equal(readFileSync(path.join(root, "state.json"), "utf8"), beforeState);
  assert.equal(lockStatus({ cwd }).owner.token, replacement.token);
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

test("snapshot reconciles orphan processed events without writing state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const eventId = emitEvent({ cwd, input: started({ taskId: "DKA-RESTART-RECOVERY" }) }).eventId;
  const root = stateRoot(cwd);
  renameSync(
    path.join(root, "events", "pending", `${eventId}.json`),
    path.join(root, "events", "processed", `${eventId}.json`),
  );
  const stateFile = path.join(root, "state.json");
  const staleState = JSON.parse(readFileSync(stateFile, "utf8"));
  staleState.processedEventIds = ["00000000-0000-4000-8000-000000000000"];
  staleState.activeClaims = { "DKA-PHANTOM": [cwd] };
  writeFileSync(stateFile, `${JSON.stringify(staleState, null, 2)}\n`);
  const persistedBefore = readFileSync(stateFile, "utf8");

  const snapshot = readSnapshot({ cwd });

  assert.deepEqual(snapshot.state.processedEventIds, [eventId]);
  assert.deepEqual(snapshot.state.activeClaims, { "DKA-RESTART-RECOVERY": [cwd] });
  assert.deepEqual(snapshot.recoveryEvents.map((event) => event.eventId), [eventId]);
  assert.equal(readFileSync(stateFile, "utf8"), persistedBefore);
});

test("ack blocks orphan processed WIP conflicts before moving or recording events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const orphan = emitEvent({ cwd, input: started({ taskId: "DKA-ORPHAN-A" }) });
  const root = stateRoot(cwd);
  renameSync(
    path.join(root, "events", "pending", `${orphan.eventId}.json`),
    path.join(root, "events", "processed", `${orphan.eventId}.json`),
  );
  const pending = emitEvent({ cwd, input: started({ taskId: "DKA-PENDING-B" }) });
  const snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.recoveryEvents.map((event) => event.eventId), [orphan.eventId]);
  assert.deepEqual(snapshot.conflicts, [{
    kind: "worktree_claims_multiple_tasks",
    worktreePath: cwd,
    taskIds: [orphan.taskId, pending.taskId],
  }]);

  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [orphan, pending]);
  for (const eventIds of [[pending.eventId], [orphan.eventId, pending.eventId]]) {
    assert.throws(
      () => ackEvents({ cwd, token, eventIds, expectedDocumentHashes: documentHashes(cwd) }),
      /active claim conflicts block ACK/,
    );
  }

  assert.equal(existsSync(path.join(root, "events", "pending", `${pending.eventId}.json`)), true);
  assert.equal(existsSync(path.join(root, "events", "processed", `${orphan.eventId}.json`)), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
});

test("ack requires every recovery event before persisting reconciled state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const orphan = emitEvent({
    cwd,
    input: started({
      taskId: "DKA-ORPHAN-FINISHED",
      action: "finished",
      status: "needs_verification",
      summary: "Orphan finished event",
    }),
  });
  const root = stateRoot(cwd);
  renameSync(
    path.join(root, "events", "pending", `${orphan.eventId}.json`),
    path.join(root, "events", "processed", `${orphan.eventId}.json`),
  );
  const pending = emitEvent({ cwd, input: started({ taskId: "DKA-RECOVERY-OMITTED" }) });
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [pending]);

  assert.throws(
    () => ackEvents({ cwd, token, eventIds: [pending.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /event IDs must include all recovery events/,
  );

  assert.equal(existsSync(path.join(root, "events", "pending", `${pending.eventId}.json`)), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  assert.equal(lockStatus({ cwd }).owner.token, token);
  releaseLock({ cwd, token });
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

test("ack uses snapshot recovery IDs and persists a fully reconciled processed state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const orphan = emitEvent({
    cwd,
    input: started({
      taskId: "DKA-RECOVER-ORPHAN",
      action: "finished",
      status: "needs_verification",
      summary: "Recover completed orphan",
    }),
  });
  const pending = emitEvent({ cwd, input: started({ taskId: "DKA-RECOVER-PENDING" }) });
  writePendingEvent(cwd, pending, "2026-08-24T00:00:00.000Z");
  writePendingEvent(cwd, orphan, "2026-08-24T00:00:01.000Z");
  const root = stateRoot(cwd);
  renameSync(
    path.join(root, "events", "pending", `${orphan.eventId}.json`),
    path.join(root, "events", "processed", `${orphan.eventId}.json`),
  );

  const recoveryIds = readSnapshot({ cwd }).recoveryEvents.map((event) => event.eventId);
  assert.deepEqual(recoveryIds, [orphan.eventId]);
  const token = acquireLock({ cwd }).token;
  renderTaskDocuments(cwd, token, [orphan, pending]);
  ackEvents({
    cwd,
    token,
    eventIds: [...recoveryIds, pending.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  const snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.recoveryEvents, []);
  assert.deepEqual(snapshot.state.processedEventIds, [pending.eventId, orphan.eventId]);
  assert.deepEqual(snapshot.state.activeClaims, { [pending.taskId]: [cwd] });
  const persisted = JSON.parse(readFileSync(path.join(root, "state.json"), "utf8"));
  assert.deepEqual(persisted.processedEventIds, [pending.eventId, orphan.eventId]);
  assert.deepEqual(persisted.activeClaims, { [pending.taskId]: [cwd] });
});

test("ack publishes a complete intent before moving events", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-INTENT" }) });
  const finished = emitEvent({
    cwd,
    input: started({
      taskId: "DKA-ACK-INTENT-FINISHED",
      action: "finished",
      status: "needs_verification",
      summary: "Finished event for sorted journal IDs",
    }),
  });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event, finished]);
  const expectedDocumentHashes = documentHashes(cwd);

  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [finished.eventId, event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );

  const root = stateRoot(cwd);
  const intent = JSON.parse(readFileSync(path.join(root, "ack-intent.json"), "utf8"));
  assert.deepEqual(intent.lockOwner, {
    token: owner.token,
    pid: owner.pid,
    acquiredAt: owner.acquiredAt,
  });
  assert.equal(intent.schemaVersion, 1);
  assert.deepEqual(intent.eventIds, [event.eventId, finished.eventId].sort());
  assert.deepEqual(intent.expectedDocumentHashes, expectedDocumentHashes);
  assert.deepEqual(intent.baselineHashes, owner.baselineHashes);
  assert.equal(Number.isNaN(Date.parse(intent.createdAt)), false);
  assert.equal(existsSync(path.join(root, "events", "pending", `${event.eventId}.json`)), true);
  assert.equal(existsSync(path.join(root, "events", "pending", `${finished.eventId}.json`)), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
});

test("snapshot exposes a safe ACK-intent recovery before event moves", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-RETRY" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );

  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.safe, true);
  assert.equal(snapshot.target.recoveryMode, "ack_intent");
  assert.deepEqual(snapshot.ackIntent.eventIds, [event.eventId]);
  assert.deepEqual(snapshot.ackRecoveryEventIds, [event.eventId]);

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: snapshot.ackRecoveryEventIds,
    expectedDocumentHashes: snapshot.ackIntent.expectedDocumentHashes,
  });
  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.equal(existsSync(path.join(root, "events", "processed", `${event.eventId}.json`)), true);
  assert.deepEqual(readSnapshot({ cwd }).state.processedEventIds, [event.eventId]);
  assert.equal(lockStatus({ cwd }).held, false);
});

test("a real process exit after ACK journal publication permits exact-token takeover", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-DEAD-JOURNAL" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);

  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "intent",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const crashedStatus = lockStatus({ cwd });
  assert.equal(crashedStatus.lifecycleIntents.length, 1);
  assert.deepEqual(
    {
      operation: crashedStatus.lifecycleIntents[0].operation,
      lockToken: crashedStatus.lifecycleIntents[0].lockToken,
      processAlive: crashedStatus.lifecycleIntents[0].processAlive,
      takeoverEligible: crashedStatus.lifecycleIntents[0].takeoverEligible,
    },
    { operation: "ack", lockToken: owner.token, processAlive: false, takeoverEligible: true },
  );
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.recoveryMode, "ack_intent");

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: snapshot.ackRecoveryEventIds,
    expectedDocumentHashes: snapshot.ackIntent.expectedDocumentHashes,
  });
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(existsSync(path.join(stateRoot(cwd), "ack-intent.json")), false);
  assert.equal(existsSync(path.join(stateRoot(cwd), "events", "processed", `${event.eventId}.json`)), true);
});

test("a SIGKILL after ACK event moves permits exact-token takeover and state recovery", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-DEAD-EVENTS" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);

  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "events",
    signal: "SIGKILL",
  });
  assert.equal(crashed.status, null);
  assert.equal(crashed.signal, "SIGKILL");
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.recoveryMode, "ack_intent");
  assert.deepEqual(snapshot.recoveryEvents.map((item) => item.eventId), [event.eventId]);

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: snapshot.ackRecoveryEventIds,
    expectedDocumentHashes: snapshot.ackIntent.expectedDocumentHashes,
  });
  assert.deepEqual(readSnapshot({ cwd }).state.processedEventIds, [event.eventId]);
  assert.equal(lockStatus({ cwd }).held, false);
});

test("a real exit after owner deletion retains the journal and exposes terminal ACK cleanup", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-CLEANUP-OWNER" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
    phase: "owner",
  });
  assert.equal(crashed.status, 86, crashed.stderr);

  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "aggregate.lock")), false);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.equal(lockStatus({ cwd }).lifecycleIntents.length, 1);
  assert.equal(lockStatus({ cwd }).recoveryMode, "ack_cleanup");
  assert.equal(readSnapshot({ cwd }).target.recoveryMode, "ack_cleanup");
  assert.throws(() => acquireLock({ cwd }), /ACK intent blocks new lock acquisition/);

  const cleanup = spawnSync(process.execPath, [helperPath, "recover-ack-cleanup", "--confirm"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
  const nextOwner = acquireLock({ cwd });
  releaseLock({ cwd, token: nextOwner.token });
});

test("a SIGKILL after owner deletion recovers multiple exact ACK markers", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-CLEANUP-MULTI" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const firstCrash = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(firstCrash.status, 86, firstCrash.stderr);
  const terminalCrash = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "owner",
    signal: "SIGKILL",
  });
  assert.equal(terminalCrash.status, null);
  assert.equal(terminalCrash.signal, "SIGKILL");
  assert.equal(lockStatus({ cwd }).lifecycleIntents.length, 2);
  assert.equal(readSnapshot({ cwd }).target.recoveryMode, "ack_cleanup");

  const cleanup = spawnSync(process.execPath, [helperPath, "recover-ack-cleanup", "--confirm"], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
  assert.equal(existsSync(path.join(stateRoot(cwd), "ack-intent.json")), false);
});

test("terminal ACK cleanup rejects document drift and preserves its journal", () => {
  const { cwd, root } = createTerminalCleanupFixture("DKA-ACK-CLEANUP-DRIFT");
  const markerNames = lockStatus({ cwd }).intentMarkers;
  assert.throws(
    () => recoverAckCleanup({ cwd }),
    /requires explicit confirmation/,
  );
  const statusFile = path.join(cwd, "docs", "project", "STATUS.md");
  writeFileSync(statusFile, `${readFileSync(statusFile, "utf8")}External drift\n`);

  assert.equal(readSnapshot({ cwd }).target.recoveryMode, undefined);
  assert.throws(
    () => recoverAckCleanup({ cwd, confirm: true }),
    /management document hashes differ from ACK intent/,
  );
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, markerNames);
});

test("terminal ACK cleanup rejects state missing an intent event ID", () => {
  const { cwd, root } = createTerminalCleanupFixture("DKA-ACK-CLEANUP-STATE");
  const stateFile = path.join(root, "state.json");
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.processedEventIds = [];
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  assert.equal(lockStatus({ cwd }).recoveryMode, undefined);
  assert.throws(
    () => recoverAckCleanup({ cwd, confirm: true }),
    /persisted state is missing ACK event IDs/,
  );
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
});

test("terminal ACK cleanup diagnoses an invalid processed event without consuming its journal", () => {
  const { cwd, event, root } = createTerminalCleanupFixture("DKA-ACK-CLEANUP-PROCESSED");
  const processedFile = path.join(root, "events", "processed", `${event.eventId}.json`);
  const processed = JSON.parse(readFileSync(processedFile, "utf8"));
  delete processed.evidence;
  writeFileSync(processedFile, `${JSON.stringify(processed, null, 2)}\n`);

  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.safe, false);
  assert.equal(snapshot.target.recoveryMode, undefined);
  assert.throws(
    () => recoverAckCleanup({ cwd, confirm: true }),
    /processed ACK event is invalid/,
  );
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
});

test("terminal ACK cleanup strictly audits the complete processed directory and derived state", () => {
  const extraId = "00000000-0000-4000-8000-000000000010";
  const variants = [
    {
      name: "extra legal orphan processed event",
      mutate({ event, root }) {
        const orphan = { ...event, eventId: extraId, createdAt: "2020-01-01T00:00:00.000Z" };
        writeFileSync(path.join(root, "events", "processed", `${extraId}.json`), `${JSON.stringify(orphan, null, 2)}\n`);
      },
    },
    {
      name: "state records a nonexistent event ID",
      mutate({ root }) {
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.processedEventIds.push(extraId);
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "state records valid processed IDs in noncanonical order",
      mutate({ event, root }) {
        const orphan = { ...event, eventId: extraId, createdAt: "2020-01-01T00:00:00.000Z" };
        writeFileSync(path.join(root, "events", "processed", `${extraId}.json`), `${JSON.stringify(orphan, null, 2)}\n`);
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.processedEventIds = [event.eventId, extraId];
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "state omits a processed event ID",
      mutate({ root }) {
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.processedEventIds = [];
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "state has a forged active claim",
      mutate({ root }) {
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.activeClaims = { "DKA-FORGED-CLAIM": ["/forged/worktree"] };
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "state omits its active claim",
      mutate({ root }) {
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.activeClaims = {};
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "state schema is invalid",
      mutate({ root }) {
        const stateFile = path.join(root, "state.json");
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        state.schemaVersion = 2;
        writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
      },
    },
    {
      name: "persisted state JSON is malformed",
      mutate({ root }) {
        writeFileSync(path.join(root, "state.json"), "{\n");
      },
    },
    {
      name: "processed directory has an invalid filename",
      mutate({ root }) {
        writeFileSync(path.join(root, "events", "processed", "unexpected.txt"), "unexpected\n");
      },
    },
    {
      name: "processed event JSON is malformed",
      mutate({ root }) {
        writeFileSync(path.join(root, "events", "processed", `${extraId}.json`), "{\n");
      },
    },
    {
      name: "processed filename and event ID differ",
      mutate({ event, root }) {
        writeFileSync(path.join(root, "events", "processed", `${extraId}.json`), `${JSON.stringify(event, null, 2)}\n`);
      },
    },
  ];

  for (const variant of variants) {
    const fixture = createTerminalCleanupFixture(`DKA-ACK-AUDIT-${variants.indexOf(variant) + 1}`);
    const markerNames = lockStatus({ cwd: fixture.cwd }).intentMarkers;
    variant.mutate(fixture);

    const snapshot = readSnapshot({ cwd: fixture.cwd });
    assert.equal(snapshot.target.safe, false, variant.name);
    assert.equal(snapshot.target.recoveryMode, undefined, variant.name);
    assert.ok(snapshot.target.reasons.length > 0, variant.name);
    assert.throws(
      () => recoverAckCleanup({ cwd: fixture.cwd, confirm: true }),
      /ACK cleanup is unsafe/,
      variant.name,
    );
    assert.equal(existsSync(path.join(fixture.root, "ack-intent.json")), true, variant.name);
    assert.deepEqual(lockStatus({ cwd: fixture.cwd }).intentMarkers, markerNames, variant.name);
  }
});

test("terminal ACK cleanup rejects a live related marker", () => {
  const { cwd, root } = createTerminalCleanupFixture("DKA-ACK-CLEANUP-LIVE");
  const markerName = lockStatus({ cwd }).intentMarkers[0];
  const markerFile = path.join(root, markerName);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  marker.pid = process.pid;
  writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);

  assert.equal(readSnapshot({ cwd }).target.recoveryMode, undefined);
  assert.throws(
    () => recoverAckCleanup({ cwd, confirm: true }),
    /live lifecycle marker blocks ACK cleanup/,
  );
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.equal(existsSync(markerFile), true);
});

test("terminal ACK cleanup rejects malformed and different-transaction markers", () => {
  for (const variant of ["malformed", "different"]) {
    const { cwd, event, root } = createTerminalCleanupFixture(`DKA-ACK-CLEANUP-${variant.toUpperCase()}`);
    const related = JSON.parse(readFileSync(path.join(root, lockStatus({ cwd }).intentMarkers[0]), "utf8"));
    const markerFile = path.join(root, `aggregate.intent-ack-${variant}`);
    if (variant === "malformed") {
      writeFileSync(markerFile, "{}\n");
    } else {
      writeFileSync(markerFile, `${JSON.stringify({
        ...related,
        token: "00000000-0000-4000-8000-000000000002",
        eventIds: ["00000000-0000-4000-8000-000000000003"],
      }, null, 2)}\n`);
    }

    assert.throws(
      () => recoverAckCleanup({ cwd, confirm: true }),
      /unrelated or invalid lifecycle marker/,
    );
    assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
    assert.equal(existsSync(markerFile), true);
    assert.equal(existsSync(path.join(root, "events", "processed", `${event.eventId}.json`)), true);
  }
});

test("terminal ACK cleanup resumes after a SIGKILL between marker rename and deletion", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-CLEANUP-TOMBSTONE" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.equal(runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  }).status, 86);
  assert.equal(runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "owner",
  }).status, 86);

  const crashedCleanup = runCrashingAckCleanup({ cwd });
  assert.equal(crashedCleanup.status, null);
  assert.equal(crashedCleanup.signal, "SIGKILL");
  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.equal(lockStatus({ cwd }).ackCleanupTombstones.length, 1);
  assert.equal(readSnapshot({ cwd }).target.recoveryMode, "ack_cleanup");

  assert.equal(recoverAckCleanup({ cwd, confirm: true }), true);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.equal(lockStatus({ cwd }).ackCleanupTombstones, undefined);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("a real process exit before ACK journal publication permits matching-owner retry", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-DEAD-PREJOURNAL" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);

  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.equal(existsSync(path.join(root, "events", "pending", `${event.eventId}.json`)), true);
  assert.deepEqual(
    {
      eventIds: lockStatus({ cwd }).lifecycleIntents[0].eventIds,
      expectedDocumentHashes: lockStatus({ cwd }).lifecycleIntents[0].expectedDocumentHashes,
      processAlive: lockStatus({ cwd }).lifecycleIntents[0].processAlive,
    },
    { eventIds: [event.eventId], expectedDocumentHashes, processAlive: false },
  );

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
  });
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("wrong event IDs cannot consume a dead pre-journal ACK marker", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const original = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-REQUEST-IDS" }) });
  const different = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-OTHER-IDS" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [original]);
  const expectedDocumentHashes = documentHashes(cwd);
  const boundEventIds = [original.eventId, different.eventId].sort().reverse();
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: boundEventIds,
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const root = stateRoot(cwd);
  const markerName = lockStatus({ cwd }).intentMarkers[0];
  const markerFile = path.join(root, markerName);
  const markerBefore = readFileSync(markerFile, "utf8");
  assert.deepEqual(JSON.parse(markerBefore).eventIds, [...boundEventIds].sort());
  assert.deepEqual(JSON.parse(markerBefore).expectedDocumentHashes, expectedDocumentHashes);

  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [different.eventId],
      expectedDocumentHashes,
    }),
    /lifecycle operation is in progress/,
  );
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, [markerName]);
  assert.equal(readFileSync(markerFile, "utf8"), markerBefore);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.throws(() => releaseLock({ cwd, token: owner.token }), /lifecycle operation is in progress/);
});

test("wrong expected hashes cannot consume a dead pre-journal ACK marker", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-REQUEST-HASH" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const root = stateRoot(cwd);
  const markerName = lockStatus({ cwd }).intentMarkers[0];
  const markerFile = path.join(root, markerName);
  const markerBefore = readFileSync(markerFile, "utf8");
  const wrongHashes = { ...expectedDocumentHashes, "AGENTS.md": "0".repeat(64) };

  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: wrongHashes,
    }),
    /lifecycle operation is in progress/,
  );
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, [markerName]);
  assert.equal(readFileSync(markerFile, "utf8"), markerBefore);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
});

test("a failed exact retry keeps the dead ACK marker until a later success", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-RETRY-ANCHOR" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const deadMarker = lockStatus({ cwd }).intentMarkers[0];

  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testAfterLifecycleAcquired() {
        const markers = lockStatus({ cwd }).intentMarkers;
        assert.equal(markers.length, 2);
        assert.ok(markers.includes(deadMarker));
        throw new Error("stop exact retry after exclusivity");
      },
    }),
    /stop exact retry after exclusivity/,
  );
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, [deadMarker]);

  ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes });
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("concurrent exact retries never both take over one dead ACK marker", async () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-TAKEOVER-RACE" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "lifecycle",
  });
  assert.equal(crashed.status, 86, crashed.stderr);

  const retries = await Promise.all([
    runAckProcess({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes }),
    runAckProcess({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes }),
  ]);
  const successes = retries.filter((result) => result.status === 0);
  assert.ok(successes.length <= 1, JSON.stringify(retries));
  if (successes.length === 0) {
    assert.ok(lockStatus({ cwd }).intentMarkers.length >= 1);
    ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes });
  }
  assert.equal(lockStatus({ cwd }).held, false);
  assert.deepEqual(readSnapshot({ cwd }).state.processedEventIds, [event.eventId]);
});

test("ACK takeover rejects a live matching marker", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-LIVE-MARKER" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  writeAckLifecycleIntent(cwd, "aggregate.intent-ack-live", {
    pid: process.pid,
    lockToken: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /lifecycle operation is in progress/,
  );
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, ["aggregate.intent-ack-live"]);
});

test("ACK takeover rejects a dead marker for a different request token", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-WRONG-TOKEN" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  writeAckLifecycleIntent(cwd, "aggregate.intent-ack-dead", {
    pid: 999999999,
    lockToken: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  assert.throws(
    () => ackEvents({
      cwd,
      token: "00000000-0000-4000-8000-000000000001",
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
    }),
    /lifecycle operation is in progress/,
  );
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, ["aggregate.intent-ack-dead"]);
});

test("ACK takeover rejects malformed and non-ACK lifecycle markers", () => {
  for (const variant of [
    { name: "aggregate.intent-ack-malformed", operation: "ack", includeLockToken: false },
    { name: "aggregate.intent-adopt-dead", operation: "adopt", includeLockToken: true },
  ]) {
    const cwd = createRepo();
    initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
    const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-BLOCKED-MARKER" }) });
    const owner = acquireLock({ cwd });
    renderTaskDocuments(cwd, owner.token, [event]);
    writeAckLifecycleIntent(cwd, variant.name, {
      pid: 999999999,
      lockToken: owner.token,
      operation: variant.operation,
      includeLockToken: variant.includeLockToken,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
    });

    assert.throws(
      () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
      /lifecycle operation is in progress/,
    );
    assert.deepEqual(lockStatus({ cwd }).intentMarkers, [variant.name]);
  }
});

test("lock status reports an out-of-range lifecycle PID as invalid and non-takeoverable", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-PID-RANGE" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  writeAckLifecycleIntent(cwd, "aggregate.intent-ack-invalid-pid", {
    pid: Number.MAX_SAFE_INTEGER,
    lockToken: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });

  assert.deepEqual(lockStatus({ cwd }).lifecycleIntents, [{
    name: "aggregate.intent-ack-invalid-pid",
    valid: false,
    takeoverEligible: false,
  }]);
  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes: documentHashes(cwd) }),
    /lifecycle operation is in progress/,
  );
});

test("ACK takeover rejects a dead matching marker when its journal owner differs", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-JOURNAL-OWNER" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  const crashed = runCrashingAck({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes,
    phase: "intent",
  });
  assert.equal(crashed.status, 86, crashed.stderr);
  const intentFile = path.join(stateRoot(cwd), "ack-intent.json");
  const intent = JSON.parse(readFileSync(intentFile, "utf8"));
  intent.lockOwner.token = "00000000-0000-4000-8000-000000000001";
  writeFileSync(intentFile, `${JSON.stringify(intent, null, 2)}\n`);

  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes }),
    /lifecycle operation is in progress/,
  );
  assert.equal(lockStatus({ cwd }).lifecycleIntents[0].processAlive, false);
  assert.equal(lockStatus({ cwd }).lifecycleIntents[0].takeoverEligible, false);
});

test("ACK lifecycle blocks acquire, release, and recover until its owner is removed", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-LIFECYCLE" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  let checked = false;

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: [event.eventId],
    expectedDocumentHashes: documentHashes(cwd),
    _testAfterLifecycleAcquired() {
      checked = true;
      assert.throws(() => acquireLock({ cwd }), /lifecycle operation is in progress/);
      assert.throws(() => releaseLock({ cwd, token: owner.token }), /lifecycle operation is in progress/);
      assert.throws(() => recoverLock({ cwd, confirm: true }), /lifecycle operation is in progress/);
      assert.throws(() => adoptDocuments({ cwd, token: owner.token }), /lifecycle operation is in progress/);
      const markers = lockStatus({ cwd }).intentMarkers;
      assert.equal(markers.length, 1);
      assert.match(markers[0], /^aggregate\.intent-ack-/);
      assert.equal(JSON.parse(readFileSync(path.join(stateRoot(cwd), markers[0]), "utf8")).operation, "ack");
    },
  });

  assert.equal(checked, true);
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
});

test("ACK revalidates its owner before writing reconciled state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-OWNER-RECHECK" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const replacement = { ...owner, token: "00000000-0000-4000-8000-000000000001" };

  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
      _testBeforeStateWrite() {
        writeFileSync(
          path.join(stateRoot(cwd), "aggregate.lock"),
          `${JSON.stringify(replacement, null, 2)}\n`,
        );
      },
    }),
    /aggregate lock token mismatch/,
  );

  const root = stateRoot(cwd);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  assert.equal(existsSync(path.join(root, "events", "processed", `${event.eventId}.json`)), true);
  assert.equal(lockStatus({ cwd }).owner.token, replacement.token);
});

test("ACK intent recovery freezes out pending events emitted after journal publication", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-FROZEN" }) });
  const firstOwner = acquireLock({ cwd });
  renderTaskDocuments(cwd, firstOwner.token, [first]);
  const firstHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: firstOwner.token,
      eventIds: [first.eventId],
      expectedDocumentHashes: firstHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const finished = emitEvent({
    cwd,
    input: started({
      taskId: first.taskId,
      action: "finished",
      status: "needs_verification",
      summary: "Finish after ACK journal publication",
    }),
  });

  assert.throws(
    () => ackEvents({
      cwd,
      token: firstOwner.token,
      eventIds: [first.eventId, finished.eventId],
      expectedDocumentHashes: firstHashes,
    }),
    /ACK intent does not match/,
  );
  ackEvents({
    cwd,
    token: firstOwner.token,
    eventIds: [first.eventId],
    expectedDocumentHashes: firstHashes,
  });

  let snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.events.map((event) => event.eventId), [finished.eventId]);
  assert.deepEqual(snapshot.state.processedEventIds, [first.eventId]);
  const secondOwner = acquireLock({ cwd });
  renderTaskDocuments(cwd, secondOwner.token, [finished]);
  ackEvents({
    cwd,
    token: secondOwner.token,
    eventIds: [finished.eventId],
    expectedDocumentHashes: documentHashes(cwd),
  });
  snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.state.processedEventIds, [first.eventId, finished.eventId]);
});

test("ACK intent recovery leaves later WIP conflicts for the next transaction", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const first = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-FROZEN-WIP" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [first]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [first.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const later = emitEvent({ cwd, input: started({ taskId: "DKA-ACK-LATER-WIP" }) });
  assert.deepEqual(readSnapshot({ cwd }).conflicts, [{
    kind: "worktree_claims_multiple_tasks",
    worktreePath: cwd,
    taskIds: [first.taskId, later.taskId].sort(),
  }]);

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: [first.eventId],
    expectedDocumentHashes,
  });

  const snapshot = readSnapshot({ cwd });
  assert.deepEqual(snapshot.events.map((event) => event.eventId), [later.eventId]);
  assert.deepEqual(snapshot.state.processedEventIds, [first.eventId]);
  assert.deepEqual(snapshot.conflicts, [{
    kind: "worktree_claims_multiple_tasks",
    worktreePath: cwd,
    taskIds: [first.taskId, later.taskId].sort(),
  }]);
});

test("ACK intent recovers events moved before state persistence", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-MOVED" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "events",
    }),
    /simulated crash after ACK event moves/,
  );

  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "events", "pending", `${event.eventId}.json`)), false);
  assert.equal(existsSync(path.join(root, "events", "processed", `${event.eventId}.json`)), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.recoveryMode, "ack_intent");
  assert.deepEqual(snapshot.recoveryEvents.map((item) => item.eventId), [event.eventId]);
  assert.deepEqual(snapshot.ackRecoveryEventIds, [event.eventId]);

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: snapshot.ackRecoveryEventIds,
    expectedDocumentHashes: snapshot.ackIntent.expectedDocumentHashes,
  });
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, [event.eventId]);
});

test("ACK intent finishes cleanup after state persistence", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-COMMITTED" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "state",
    }),
    /simulated crash after ACK state/,
  );

  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, [event.eventId]);
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.safe, true);
  assert.equal(snapshot.target.recoveryMode, "ack_intent");
  assert.deepEqual(snapshot.recoveryEvents, []);

  ackEvents({
    cwd,
    token: owner.token,
    eventIds: snapshot.ackRecoveryEventIds,
    expectedDocumentHashes: snapshot.ackIntent.expectedDocumentHashes,
  });
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.equal(lockStatus({ cwd }).held, false);
});

test("an error after journal deletion observes a fully cleaned terminal state", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-RELEASE" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
      _testCrashAfterPhase: "journal",
    }),
    /simulated crash after ACK journal cleanup/,
  );

  const root = stateRoot(cwd);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, [event.eventId]);
  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.safe, true);
  assert.equal(snapshot.target.recoveryMode, undefined);
  assert.equal(snapshot.ackIntentExists, false);
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(lockStatus({ cwd }).intentMarkers, undefined);
  const nextOwner = acquireLock({ cwd });
  releaseLock({ cwd, token: nextOwner.token });
});

test("ACK intent rejects fields outside its fixed journal schema", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-SCHEMA" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const intentFile = path.join(stateRoot(cwd), "ack-intent.json");
  const injected = JSON.parse(readFileSync(intentFile, "utf8"));
  injected.command = "npm test";
  writeFileSync(intentFile, `${JSON.stringify(injected, null, 2)}\n`);

  const snapshot = readSnapshot({ cwd });
  assert.equal(snapshot.target.safe, false);
  assert.deepEqual(snapshot.target.reasons, ["ACK intent is invalid"]);
  assert.equal(snapshot.ackIntentExists, true);
  assert.equal(snapshot.ackIntent, null);
  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes }),
    /ACK intent is invalid/,
  );
});

test("ACK intent hard-blocks document, owner, token, event ID, and hash mismatches", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-MISMATCH" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  const expectedDocumentHashes = documentHashes(cwd);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes,
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const root = stateRoot(cwd);
  const statusFile = path.join(cwd, "docs", "project", "STATUS.md");
  const projectedStatus = readFileSync(statusFile, "utf8");
  writeFileSync(statusFile, `${projectedStatus}\nExternal drift\n`);
  assert.equal(readSnapshot({ cwd }).target.safe, false);
  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [event.eventId], expectedDocumentHashes }),
    /management document hashes do not match expected results/,
  );
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
    }),
    /ACK intent does not match/,
  );

  writeFileSync(statusFile, projectedStatus);
  const lockFile = path.join(root, "aggregate.lock");
  writeFileSync(lockFile, `${JSON.stringify({ ...owner, token: "00000000-0000-4000-8000-000000000001" }, null, 2)}\n`);
  assert.equal(readSnapshot({ cwd }).target.safe, false);
  writeFileSync(lockFile, `${JSON.stringify(owner, null, 2)}\n`);
  assert.throws(
    () => ackEvents({
      cwd,
      token: "00000000-0000-4000-8000-000000000001",
      eventIds: [event.eventId],
      expectedDocumentHashes,
    }),
    /aggregate lock token mismatch/,
  );

  const other = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-OTHER" }) });
  assert.throws(
    () => ackEvents({ cwd, token: owner.token, eventIds: [other.eventId], expectedDocumentHashes }),
    /ACK intent does not match/,
  );
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
  assert.equal(existsSync(path.join(root, "events", "pending", `${event.eventId}.json`)), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "state.json"), "utf8")).processedEventIds, []);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
});

test("an unfinished ACK intent prevents releasing its valid owner", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-OWNER" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );

  assert.throws(
    () => releaseLock({ cwd, token: owner.token }),
    /ACK intent must be completed before releasing its owner/,
  );
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  assert.equal(existsSync(path.join(stateRoot(cwd), "ack-intent.json")), true);
});

test("an orphaned ACK intent blocks publishing a replacement owner", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const event = emitEvent({ cwd, input: started({ taskId: "DKA-INTENT-ORPHANED" }) });
  const owner = acquireLock({ cwd });
  renderTaskDocuments(cwd, owner.token, [event]);
  assert.throws(
    () => ackEvents({
      cwd,
      token: owner.token,
      eventIds: [event.eventId],
      expectedDocumentHashes: documentHashes(cwd),
      _testCrashAfterPhase: "intent",
    }),
    /simulated crash after ACK intent/,
  );
  const root = stateRoot(cwd);
  unlinkSync(path.join(root, "aggregate.lock"));

  assert.throws(
    () => acquireLock({ cwd }),
    /ACK intent blocks new lock acquisition/,
  );
  assert.equal(lockStatus({ cwd }).held, false);
  assert.equal(existsSync(path.join(root, "ack-intent.json")), true);
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

test("a lifecycle intent blocks acquire and release before either reads or changes owner", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const owner = acquireLock({ cwd });
  const intent = path.join(root, "aggregate.intent-release-test");
  writeLifecycleIntent(cwd, path.basename(intent), process.pid);
  assert.throws(() => acquireLock({ cwd }), /lifecycle operation is in progress/);
  assert.throws(() => releaseLock({ cwd, token: owner.token }), /lifecycle operation is in progress/);
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, ["aggregate.intent-release-test"]);
  assert.equal(lockStatus({ cwd }).owner.token, owner.token);
  unlinkSync(intent);
  assert.equal(releaseLock({ cwd, token: owner.token }), true);
  assert.ok(acquireLock({ cwd }).token);
});

test("a dead lifecycle marker blocks recovery and is never deleted implicitly", () => {
  const cwd = createRepo();
  initStore({ cwd, managementWorktree: cwd, managementBranch: "main" });
  const root = stateRoot(cwd);
  const lock = path.join(root, "aggregate.lock");
  mkdirSync(lock);
  writeLifecycleIntent(cwd, "aggregate.intent-recover-dead", 999999999);
  assert.throws(() => recoverLock({ cwd, confirm: true }), /lifecycle operation is in progress/);
  assert.equal(existsSync(lock), true);
  assert.deepEqual(lockStatus({ cwd }).intentMarkers, ["aggregate.intent-recover-dead"]);
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
  assert.throws(() => recoverLock({ cwd, confirm: true }), /lifecycle operation is in progress/);
  assert.ok(lockStatus({ cwd }).intentMarkers.includes(intent));
  unlinkSync(path.join(stateRoot(cwd), intent));
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
  assert.match(skill, /recoveryEvents.*event-ids/);
  assert.match(skill, /processed.*source of truth/i);
  assert.match(skill, /recoveryMode.*ack_intent/);
  assert.match(skill, /do not re-render or adopt/i);
  assert.match(skill, /ACK intent.*release-lock/);
  assert.match(skill, /write state.*delete owner.*clean exact markers.*delete journal last/i);
  assert.match(skill, /existing ACK journal.*later pending.*next aggregation/i);
  assert.match(skill, /dead matching ACK marker.*retry.*exact request/i);
  assert.match(skill, /ACK marker.*sorted.*eventIds.*expected.*hash/i);
  assert.match(skill, /wrong.*eventIds.*hashes.*marker.*intact/i);
  assert.match(skill, /only.*successful ACK.*removes.*dead.*marker/i);
  assert.match(skill, /recoveryMode.*ack_cleanup.*recover-ack-cleanup --confirm/i);
  assert.match(skill, /ack_cleanup.*do not.*ordinary ACK.*recover-lock/i);
  assert.match(skill, /every processed directory entry.*canonical UUID.*regular file/i);
  assert.match(skill, /without an ACK journal.*retry.*original token.*eventIds.*expected hashes/i);
  assert.match(skill, /original ACK parameters.*lost.*manual stop/i);
  assert.match(skill, /owner PID.*never.*lease.*dead/i);
  assert.match(skill, /different-token.*different-operation.*hard stop/i);
  assert.match(skill, /adopt.*lifecycle marker.*reject.*ACK intent/i);
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
  assert.match(contracts, /read-only reconciled.*recoveryEvents/);
  assert.match(contracts, /all recoveryEvents.*eventIds/);
  assert.match(contracts, /ack-intent\.json/);
  assert.match(contracts, /same token.*eventIds.*hashes/);
  assert.match(contracts, /intent.*move.*state.*delete.*release/i);
  assert.match(contracts, /ACK lifecycle marker.*release.*recover.*acquire/i);
  assert.match(contracts, /journal freezes.*eventIds.*expectedDocumentHashes/i);
  assert.match(contracts, /short-lived lifecycle PID.*dead matching ACK marker/i);
  assert.match(contracts, /dead ACK marker.*left in place.*live retry marker/i);
  assert.match(contracts, /validation failure.*dead marker.*unchanged/i);
  assert.match(contracts, /state.*owner.*markers.*journal.*last/i);
  assert.match(contracts, /ownerless terminal.*projection.*processed/i);
  assert.match(contracts, /cleanup tombstone.*journal.*retry/i);
  assert.match(contracts, /processedEventIds.*activeClaims.*derived.*exact/i);
  assert.match(contracts, /before journal publication.*original token.*eventIds.*expected hashes/i);
  assert.match(contracts, /adopt.*lockToken.*owner token.*state write/i);
  assert.match(contracts, /git diff --check.*cannot/);
  assert.match(contracts, /deterministically downgrades.*`needs_verification`/);
  const report = readFileSync(path.join(repositoryRoot, ".superpowers/sdd/final-fix-report.md"), "utf8");
  assert.doesNotMatch(report, /owner PID.*ESRCH/);
  assert.match(report, /canonical event projection/);
  assert.match(report, /latest current projection/);
  assert.match(report, /folded latest projection/);
  assert.match(report, /processed directory.*source of truth/);
  assert.match(report, /two-phase ACK journal/);
  assert.match(report, /committed-cleanup.*recover-ack-cleanup/i);
  assert.match(report, /full processed audit/i);
});
