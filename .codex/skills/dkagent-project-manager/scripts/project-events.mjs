#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENT_FIELDS = new Set(["taskId", "action", "module", "summary", "status", "dependencies", "evidence", "discoveredTodos"]);
const ACTIONS = new Set(["started", "finished", "blocked", "discovered"]);
const STATUSES = new Set(["in_progress", "completed", "needs_verification", "blocked"]);
const EXECUTION_EVIDENCE = new Set(["test", "typecheck", "build"]);
const EVIDENCE_KINDS = new Set(["test", "typecheck", "build", "commit", "user_confirmation"]);
const EVIDENCE_FIELDS = new Set(["kind", "summary", "command", "exitCode"]);
const DISCOVERED_FIELDS = new Set(["summary", "module", "reason"]);
const DOCUMENTS = ["AGENTS.md", "docs/project/STATUS.md", "docs/project/BACKLOG.md"];
const SECRET_ASSIGNMENT = /\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*=\s*\S+/i;
const BEARER_TOKEN = /\bBearer\s+\S+/i;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]+\b/i;
const SHELL_CONSTRUCT = /[;|&()`<>'"\\]/;
const SENSITIVE_HEADER = /\b(?:x-)?api-key\s*:\s*\S+|\bauthorization\s*:\s*\S+/i;
const SENSITIVE_FLAG = /(?:^|\s)--[a-z0-9-]*(?:api-key|apikey|token|secret|password|passphrase|authorization|auth|credential|private-key)[a-z0-9-]*(?:\s+\S+|=\S+|$)/i;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i;
const ENVIRONMENT_ASSIGNMENT_TOKEN = /[A-Za-z_][A-Za-z0-9_]*=/;
const PATH_TOKEN = /^(?:\/|\.{1,2}\/)?[A-Za-z0-9_./*-]+$/;
const TEST_PATH = /\.test\.[cm]?[jt]s$/;
const NODE_CHECK_PATH = /\.[cm]?js$/;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOCUMENT_HASH = /^[0-9a-f]{64}$/;
const LOCK_FILE = "aggregate.lock";
const LOCK_CREATING_PREFIX = "aggregate.lock.creating-";
const LOCK_RECOVERY_PREFIX = "aggregate.lock.recovery-";
const LOCK_INTENT_PREFIX = "aggregate.intent-";
const LOCK_INTENT_CREATING_PREFIX = "aggregate.intent.creating-";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, file);
}

function hashFile(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function documentHashes(root) {
  return Object.fromEntries(DOCUMENTS.map((relative) => [relative, hashFile(path.join(root, relative))]));
}

function validDocumentHashes(hashes) {
  return hashes
    && typeof hashes === "object"
    && !Array.isArray(hashes)
    && Object.keys(hashes).length === DOCUMENTS.length
    && DOCUMENTS.every((relative) => Object.hasOwn(hashes, relative) && (hashes[relative] === null || (typeof hashes[relative] === "string" && DOCUMENT_HASH.test(hashes[relative]))));
}

function sameDocumentHashes(left, right) {
  return validDocumentHashes(left) && validDocumentHashes(right)
    && DOCUMENTS.every((relative) => left[relative] === right[relative]);
}

function validLockOwner(owner) {
  return owner
    && typeof owner === "object"
    && !Array.isArray(owner)
    && EVENT_ID.test(owner.token)
    && Number.isInteger(owner.pid)
    && typeof owner.acquiredAt === "string"
    && !Number.isNaN(Date.parse(owner.acquiredAt))
    && validDocumentHashes(owner.baselineHashes);
}

function readLockOwner(lock) {
  try {
    const ownerFile = statSync(lock).isDirectory() ? path.join(lock, "owner.json") : lock;
    const owner = readJson(ownerFile);
    return validLockOwner(owner) ? owner : null;
  } catch {
    return null;
  }
}

function validLifecycleIntent(intent) {
  return intent
    && typeof intent === "object"
    && !Array.isArray(intent)
    && new Set(["release", "recover"]).has(intent.operation)
    && EVENT_ID.test(intent.token)
    && Number.isInteger(intent.pid)
    && intent.pid > 0
    && typeof intent.createdAt === "string"
    && !Number.isNaN(Date.parse(intent.createdAt));
}

function readLifecycleIntent(marker) {
  try {
    const intent = readJson(marker);
    return validLifecycleIntent(intent) ? intent : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function lockDiagnostics(root) {
  const entries = existsSync(root) ? readdirSync(root) : [];
  const recoveryTombstones = entries.filter((name) => name.startsWith(LOCK_RECOVERY_PREFIX)).sort();
  const blockingTombstones = recoveryTombstones
    .filter((name) => readLockOwner(path.join(root, name)))
    .sort();
  return {
    recoveryTombstones,
    blockingTombstones,
    creatingFiles: entries.filter((name) => name.startsWith(LOCK_CREATING_PREFIX)).sort(),
    intentMarkers: entries
      .filter((name) => name.startsWith(LOCK_INTENT_PREFIX) && !name.startsWith(LOCK_INTENT_CREATING_PREFIX))
      .sort(),
    intentCreatingFiles: entries.filter((name) => name.startsWith(LOCK_INTENT_CREATING_PREFIX)).sort(),
  };
}

function createLifecycleIntent(root, operation) {
  const intent = { operation, token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const marker = path.join(root, `${LOCK_INTENT_PREFIX}${operation}-${intent.token}`);
  const creating = path.join(root, `${LOCK_INTENT_CREATING_PREFIX}${randomUUID()}`);
  writeFileSync(creating, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(creating, marker);
  } finally {
    if (existsSync(creating)) unlinkSync(creating);
  }
  return marker;
}

function removeLifecycleIntent(marker) {
  if (existsSync(marker)) rmSync(marker, { recursive: true });
}

function hasOtherLifecycleIntent(diagnostics, marker) {
  const ownName = path.basename(marker);
  return diagnostics.intentMarkers.some((name) => name !== ownName);
}

function containsHighConfidenceCredential(value) {
  return SECRET_ASSIGNMENT.test(value)
    || BEARER_TOKEN.test(value)
    || SK_TOKEN.test(value)
    || SENSITIVE_HEADER.test(value)
    || URL_USERINFO.test(value);
}

function areTestPaths(tokens) {
  return tokens.every((token) => PATH_TOKEN.test(token) && TEST_PATH.test(token));
}

function isAllowedValidationCommand(tokens) {
  const [executable, subcommand] = tokens;
  if (executable === "npm") {
    return (tokens.length === 2 && subcommand === "test")
      || (tokens.length === 3 && subcommand === "run" && /^[a-zA-Z0-9:_-]+$/.test(tokens[2] || ""));
  }
  if (executable === "node") {
    return (subcommand === "--test" && areTestPaths(tokens.slice(2)))
      || (subcommand === "--check" && tokens.length === 3 && PATH_TOKEN.test(tokens[2]) && NODE_CHECK_PATH.test(tokens[2]));
  }
  if (executable === "git") return tokens.length === 3 && subcommand === "diff" && tokens[2] === "--check";
  if (executable === "python3") return tokens.length === 3 && PATH_TOKEN.test(subcommand || "") && /quick_validate\.py$/.test(subcommand) && PATH_TOKEN.test(tokens[2]);
  if (executable === "tsx") return subcommand === "--test" && areTestPaths(tokens.slice(2));
  if (executable === "npx") {
    return (subcommand === "tsx" && tokens[2] === "--test" && areTestPaths(tokens.slice(3)))
      || (tokens.length === 3 && subcommand === "tsc" && tokens[2] === "--noEmit")
      || (tokens.length === 3 && subcommand === "vitest" && tokens[2] === "--run");
  }
  return false;
}

function isUnsafeSimpleCommand(command) {
  if (SHELL_CONSTRUCT.test(command) || SENSITIVE_FLAG.test(command)) {
    return true;
  }
  const tokens = command.trim().split(/\s+/);
  return tokens.some((token) => ENVIRONMENT_ASSIGNMENT_TOKEN.test(token)) || !isAllowedValidationCommand(tokens);
}

function validateStoredText(value, field, maximumLength, { singleLine = false, command = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > maximumLength) throw new Error(`${field} text is too long`);
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${field} must be a single line`);
  if (containsHighConfidenceCredential(value) || (command && isUnsafeSimpleCommand(value))) {
    throw new Error("unsafe text content");
  }
}

export function stateRoot(cwd) {
  return path.join(path.resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])), "dkagent-project-manager");
}

export function initStore({ cwd, managementWorktree, managementBranch = "main" }) {
  const root = stateRoot(cwd);
  if (existsSync(path.join(root, "config.json"))) throw new Error("project manager store already initialized");

  const resolved = path.resolve(managementWorktree);
  if (stateRoot(resolved) !== root) throw new Error("management worktree does not share the Git common directory");

  const branch = git(resolved, ["branch", "--show-current"]);
  if (branch !== managementBranch) {
    throw new Error(`management branch mismatch: expected ${managementBranch}, got ${branch || "detached"}`);
  }

  mkdirSync(path.join(root, "events", "pending"), { recursive: true });
  mkdirSync(path.join(root, "events", "processed"), { recursive: true });
  const config = { schemaVersion: 1, managementWorktree: resolved, managementBranch };
  writeJsonAtomic(path.join(root, "config.json"), config);
  writeJsonAtomic(path.join(root, "state.json"), {
    schemaVersion: 1,
    processedEventIds: [],
    activeClaims: {},
    documentHashes: documentHashes(resolved),
    lastSynchronizedAt: null,
  });
  return config;
}

function validateInput(input) {
  for (const key of Object.keys(input)) {
    if (!EVENT_FIELDS.has(key)) throw new Error(`unknown event field: ${key}`);
  }
  for (const key of ["taskId", "module", "summary"]) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} is required`);
  }
  validateStoredText(input.taskId, "taskId", 128);
  validateStoredText(input.module, "module", 120);
  validateStoredText(input.summary, "summary", 500);
  if (!ACTIONS.has(input.action)) throw new Error("invalid action");
  if (!STATUSES.has(input.status)) throw new Error("invalid status");
  for (const key of ["dependencies", "evidence", "discoveredTodos"]) {
    if (!Array.isArray(input[key])) throw new Error(`${key} must be an array`);
  }
  if (input.dependencies.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("dependencies must contain non-empty task IDs");
  }
  for (const dependency of input.dependencies) validateStoredText(dependency, "dependency", 128);
  for (const evidence of input.evidence) {
    for (const key of Object.keys(evidence)) {
      if (!EVIDENCE_FIELDS.has(key)) throw new Error(`unknown evidence field: ${key}`);
    }
    if (!EVIDENCE_KINDS.has(evidence.kind) || typeof evidence.summary !== "string" || !evidence.summary.trim()) {
      throw new Error("invalid evidence item");
    }
    validateStoredText(evidence.summary, "evidence summary", 500);
    if (EXECUTION_EVIDENCE.has(evidence.kind) && evidence.command === undefined) {
      throw new Error("evidence command is required");
    }
    if (evidence.command !== undefined) validateStoredText(evidence.command, "command", 1000, { singleLine: true, command: true });
    if (EXECUTION_EVIDENCE.has(evidence.kind) && evidence.exitCode === undefined) {
      throw new Error("evidence exitCode is required");
    }
    if (evidence.exitCode !== undefined && !Number.isInteger(evidence.exitCode)) {
      throw new Error("evidence exitCode must be an integer");
    }
  }
  for (const todo of input.discoveredTodos) {
    for (const key of Object.keys(todo)) {
      if (!DISCOVERED_FIELDS.has(key)) throw new Error(`unknown discovered todo field: ${key}`);
    }
    for (const key of DISCOVERED_FIELDS) {
      if (typeof todo[key] !== "string" || !todo[key].trim()) {
        throw new Error(`discovered todo ${key} is required`);
      }
    }
    validateStoredText(todo.summary, "discovered todo summary", 500);
    validateStoredText(todo.module, "discovered todo module", 120);
    validateStoredText(todo.reason, "discovered todo reason", 500);
  }
  if (input.action === "started" && input.status !== "in_progress") {
    throw new Error("started event must be in_progress");
  }
  if (input.action === "blocked" && input.status !== "blocked") {
    throw new Error("blocked event must be blocked");
  }
  if (input.action === "finished" && !new Set(["completed", "needs_verification"]).has(input.status)) {
    throw new Error("finished event has invalid status");
  }
  if (input.status === "completed") {
    const proved = input.evidence.some(
      (item) => item.kind === "user_confirmation" || (EXECUTION_EVIDENCE.has(item.kind) && item.exitCode === 0),
    );
    if (!proved) throw new Error("completed code task requires successful behavioral evidence");
  }
}

export function emitEvent({ cwd, input }) {
  validateInput(input);
  const root = stateRoot(cwd);
  if (!existsSync(path.join(root, "config.json"))) throw new Error("project manager store is not initialized");

  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    ...input,
    worktreePath: path.resolve(cwd),
    branch: git(cwd, ["branch", "--show-current"]) || "detached",
    headSha: git(cwd, ["rev-parse", "HEAD"]),
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(root, "events", "pending", `${event.eventId}.json`), event);
  return event;
}

function requireToken(root, token) {
  const lock = path.join(root, LOCK_FILE);
  if (!existsSync(lock)) throw new Error("aggregate lock is not held");
  const owner = readLockOwner(lock);
  if (!owner) throw new Error("aggregate lock owner is invalid; explicit recovery required");
  if (owner.token !== token) throw new Error("aggregate lock token mismatch");
  return owner;
}

function isStoredEvent(event, eventId) {
  return event
    && event.eventId === eventId
    && typeof event.taskId === "string"
    && Boolean(event.taskId.trim())
    && typeof event.worktreePath === "string"
    && Boolean(event.worktreePath)
    && typeof event.createdAt === "string"
    && !Number.isNaN(Date.parse(event.createdAt))
    && ACTIONS.has(event.action)
    && STATUSES.has(event.status);
}

function applyActiveClaim(activeClaims, event) {
  const claims = new Set(activeClaims[event.taskId] ?? []);
  if (event.action === "started" && event.status === "in_progress") claims.add(event.worktreePath);
  if (event.action === "finished" || event.action === "blocked") claims.delete(event.worktreePath);
  if (claims.size) activeClaims[event.taskId] = [...claims].sort();
  else delete activeClaims[event.taskId];
}

function replayActiveClaims(root) {
  const processed = path.join(root, "events", "processed");
  const events = readdirSync(processed)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ eventId: name.slice(0, -".json".length), file: path.join(processed, name) }))
    .filter(({ eventId }) => EVENT_ID.test(eventId))
    .map(({ eventId, file }) => ({ eventId, event: readJson(file) }))
    .filter(({ eventId, event }) => isStoredEvent(event, eventId))
    .map(({ event }) => event)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
  const activeClaims = {};
  for (const event of events) applyActiveClaim(activeClaims, event);
  return activeClaims;
}

function targetStatus(config, state) {
  const reasons = [];
  if (!existsSync(config.managementWorktree)) reasons.push("management worktree is missing");
  else {
    const branch = git(config.managementWorktree, ["branch", "--show-current"]);
    if (branch !== config.managementBranch) reasons.push(`management branch mismatch: ${branch || "detached"}`);
    const actual = documentHashes(config.managementWorktree);
    for (const relative of DOCUMENTS) {
      if (actual[relative] !== state.documentHashes[relative]) reasons.push(`${relative} hash changed`);
    }
  }
  return { safe: reasons.length === 0, reasons, managementWorktree: config.managementWorktree };
}

function activeClaimConflicts(state, events) {
  const byTask = new Map(
    Object.entries(state.activeClaims).map(([taskId, worktrees]) => [taskId, new Set(worktrees)]),
  );
  for (const event of [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId))) {
    const worktrees = byTask.get(event.taskId) ?? new Set();
    if (event.action === "started" && event.status === "in_progress") worktrees.add(event.worktreePath);
    if (event.action === "finished" || event.action === "blocked") worktrees.delete(event.worktreePath);
    if (worktrees.size) byTask.set(event.taskId, worktrees);
    else byTask.delete(event.taskId);
  }
  return [...byTask]
    .filter(([, worktrees]) => worktrees.size > 1)
    .map(([taskId, worktrees]) => ({ taskId, worktrees: [...worktrees].sort() }));
}

export function acquireLock({ cwd }) {
  const root = stateRoot(cwd);
  const diagnostics = lockDiagnostics(root);
  if (diagnostics.blockingTombstones.length) {
    throw new Error("owned recovery tombstone blocks aggregation; manual inspection required");
  }
  if (diagnostics.intentMarkers.length) throw new Error("aggregate lifecycle operation is in progress");
  const lock = path.join(root, LOCK_FILE);
  const owner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    baselineHashes: documentHashes(readJson(path.join(root, "config.json")).managementWorktree),
  };
  const creating = path.join(root, `${LOCK_CREATING_PREFIX}${randomUUID()}`);
  writeFileSync(creating, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(creating, lock);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("aggregate lock is held");
    throw error;
  } finally {
    if (existsSync(creating)) unlinkSync(creating);
  }
  let publishedInode;
  try {
    publishedInode = statSync(lock).ino;
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("aggregate lifecycle operation is in progress; retry acquisition");
    throw error;
  }
  const afterPublish = lockDiagnostics(root);
  const currentOwner = readLockOwner(lock);
  const currentInode = existsSync(lock) ? statSync(lock).ino : null;
  if (afterPublish.blockingTombstones.length || afterPublish.intentMarkers.length || currentOwner?.token !== owner.token || currentInode !== publishedInode) {
    if (currentOwner?.token === owner.token && currentInode === publishedInode) unlinkSync(lock);
    if (afterPublish.blockingTombstones.length) {
      throw new Error("owned recovery tombstone blocks aggregation; manual inspection required");
    }
    throw new Error("aggregate lifecycle operation is in progress; retry acquisition");
  }
  return owner;
}

export function releaseLock({ cwd, token }) {
  const root = stateRoot(cwd);
  const marker = createLifecycleIntent(root, "release");
  try {
    requireToken(root, token);
    const lock = path.join(root, LOCK_FILE);
    try {
      if (statSync(lock).isDirectory()) {
        const tombstone = path.join(root, `${LOCK_RECOVERY_PREFIX}${randomUUID()}`);
        renameSync(lock, tombstone);
        rmSync(tombstone, { recursive: true });
      } else {
        unlinkSync(lock);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return true;
  } finally {
    removeLifecycleIntent(marker);
  }
}

export function lockStatus({ cwd }) {
  const root = stateRoot(cwd);
  const lock = path.join(root, LOCK_FILE);
  const diagnostics = lockDiagnostics(root);
  const status = existsSync(lock)
    ? (() => {
      const owner = readLockOwner(lock);
      return { held: true, recoverable: !owner, owner };
    })()
    : { held: false, recoverable: false, owner: null };
  const result = { ...status, recoveryTombstones: diagnostics.recoveryTombstones };
  if (diagnostics.blockingTombstones.length) result.blockingTombstones = diagnostics.blockingTombstones;
  if (diagnostics.creatingFiles.length) result.creatingFiles = diagnostics.creatingFiles;
  if (diagnostics.intentMarkers.length) result.intentMarkers = diagnostics.intentMarkers;
  if (diagnostics.intentCreatingFiles.length) result.intentCreatingFiles = diagnostics.intentCreatingFiles;
  return result;
}

export function recoverLock({ cwd, confirm = false }) {
  const root = stateRoot(cwd);
  const lock = path.join(root, LOCK_FILE);
  const marker = createLifecycleIntent(root, "recover");
  try {
    let diagnostics = lockDiagnostics(root);
    let cleanedStaleIntents = false;
    const currentOwner = readLockOwner(lock);
    if (currentOwner) throw new Error("aggregate lock owner exists; release requires token");
    if (diagnostics.blockingTombstones.length) {
      throw new Error("owned recovery tombstone blocks aggregation; manual inspection required");
    }
    if (hasOtherLifecycleIntent(diagnostics, marker)) {
      const otherIntents = diagnostics.intentMarkers.filter((name) => name !== path.basename(marker));
      if (otherIntents.some((name) => {
        const intent = readLifecycleIntent(path.join(root, name));
        return intent && isProcessAlive(intent.pid);
      })) {
        throw new Error("aggregate lifecycle operation is in progress");
      }
      if (confirm !== true) throw new Error("lock recovery requires explicit confirmation");
      for (const name of otherIntents) {
        if (name !== path.basename(marker)) {
          removeLifecycleIntent(path.join(root, name));
          cleanedStaleIntents = true;
        }
      }
      diagnostics = lockDiagnostics(root);
    }
    if (!existsSync(lock)) {
      if (!diagnostics.creatingFiles.length) {
        if (cleanedStaleIntents) return true;
        throw new Error("aggregate lock is not held");
      }
      if (confirm !== true) throw new Error("lock recovery requires explicit confirmation");
      for (const name of diagnostics.creatingFiles) {
        const creating = path.join(root, name);
        const tombstone = path.join(root, `${LOCK_RECOVERY_PREFIX}${randomUUID()}`);
        try {
          renameSync(creating, tombstone);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        rmSync(tombstone, { recursive: true });
      }
      return true;
    }
    if (confirm !== true) throw new Error("lock recovery requires explicit confirmation");
    const tombstone = path.join(root, `${LOCK_RECOVERY_PREFIX}${randomUUID()}`);
    try {
      renameSync(lock, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("aggregate lock is not held");
      throw error;
    }
    if (readLockOwner(tombstone)) {
      throw new Error("lock recovery found an owner; tombstone retained");
    }
    rmSync(tombstone, { recursive: true });
    return true;
  } finally {
    removeLifecycleIntent(marker);
  }
}

export function readSnapshot({ cwd, token } = {}) {
  const root = stateRoot(cwd);
  if (token) requireToken(root, token);
  const pending = path.join(root, "events", "pending");
  const events = readdirSync(pending)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(pending, name)));
  const config = readJson(path.join(root, "config.json"));
  const state = readJson(path.join(root, "state.json"));
  return { config, state, events, conflicts: activeClaimConflicts(state, events), target: targetStatus(config, state) };
}

export function ackEvents({ cwd, token, eventIds, expectedDocumentHashes }) {
  const root = stateRoot(cwd);
  const owner = requireToken(root, token);
  const config = readJson(path.join(root, "config.json"));
  const stateFile = path.join(root, "state.json");
  const state = readJson(stateFile);
  if (!sameDocumentHashes(owner.baselineHashes, state.documentHashes)) {
    throw new Error("document baseline changed after lock acquisition");
  }
  if (!existsSync(config.managementWorktree)) throw new Error("management worktree is missing");
  const branch = git(config.managementWorktree, ["branch", "--show-current"]);
  if (branch !== config.managementBranch) throw new Error(`management branch mismatch: ${branch || "detached"}`);
  if (!validDocumentHashes(expectedDocumentHashes)) throw new Error("invalid expected document hashes");
  const currentDocumentHashes = documentHashes(config.managementWorktree);
  if (!sameDocumentHashes(currentDocumentHashes, expectedDocumentHashes)) {
    throw new Error("management document hashes do not match expected results");
  }
  if (!Array.isArray(eventIds) || eventIds.some((eventId) => typeof eventId !== "string" || !EVENT_ID.test(eventId))) {
    throw new Error("invalid event ID");
  }
  for (const eventId of eventIds) {
    if (state.processedEventIds.includes(eventId)) continue;
    const source = path.join(root, "events", "pending", `${eventId}.json`);
    const destination = path.join(root, "events", "processed", `${eventId}.json`);
    if (!existsSync(source) && !existsSync(destination)) throw new Error(`event not found: ${eventId}`);
    const event = readJson(existsSync(source) ? source : destination);
    if (existsSync(source)) renameSync(source, destination);
    state.processedEventIds.push(eventId);
  }
  state.activeClaims = replayActiveClaims(root);
  state.documentHashes = currentDocumentHashes;
  state.lastSynchronizedAt = new Date().toISOString();
  writeJsonAtomic(stateFile, state);
  releaseLock({ cwd, token });
  return state;
}

export function adoptDocuments({ cwd, token }) {
  const root = stateRoot(cwd);
  requireToken(root, token);
  const config = readJson(path.join(root, "config.json"));
  if (!existsSync(config.managementWorktree)) throw new Error("management worktree is missing");
  const branch = git(config.managementWorktree, ["branch", "--show-current"]);
  if (branch !== config.managementBranch) throw new Error(`management branch mismatch: ${branch || "detached"}`);
  const stateFile = path.join(root, "state.json");
  const state = readJson(stateFile);
  state.documentHashes = documentHashes(config.managementWorktree);
  writeJsonAtomic(stateFile, state);
  releaseLock({ cwd, token });
  return state;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
}

function readExpectedDocumentHashes(cwd, file) {
  const root = realpathSync(cwd);
  const candidate = path.resolve(root, file);
  if (path.extname(candidate) !== ".json" || path.relative(root, candidate).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(root, candidate))) {
    throw new Error("expected hashes file must be a JSON file inside cwd");
  }
  const resolved = realpathSync(candidate);
  if (path.relative(root, resolved).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(root, resolved))) {
    throw new Error("expected hashes file must be a JSON file inside cwd");
  }
  const hashes = readJson(resolved);
  if (!validDocumentHashes(hashes)) throw new Error("invalid expected document hashes");
  return hashes;
}

async function main(args) {
  const [command] = args;
  const cwd = process.cwd();
  if (command === "init") {
    return initStore({
      cwd,
      managementWorktree: valueAfter(args, "--management-worktree"),
      managementBranch: args.includes("--management-branch") ? valueAfter(args, "--management-branch") : "main",
    });
  }
  if (command === "emit") return emitEvent({ cwd, input: readJson(path.resolve(valueAfter(args, "--file"))) });
  if (command === "acquire-lock") return acquireLock({ cwd });
  if (command === "release-lock") return { released: releaseLock({ cwd, token: valueAfter(args, "--token") }) };
  if (command === "lock-status") return lockStatus({ cwd });
  if (command === "recover-lock") return { recovered: recoverLock({ cwd, confirm: args.includes("--confirm") }) };
  if (command === "adopt-documents") return adoptDocuments({ cwd, token: valueAfter(args, "--token") });
  if (command === "ack") {
    return ackEvents({
      cwd,
      token: valueAfter(args, "--token"),
      eventIds: valueAfter(args, "--event-ids").split(",").filter(Boolean),
      expectedDocumentHashes: readExpectedDocumentHashes(cwd, valueAfter(args, "--expected-hashes-file")),
    });
  }
  if (command === "snapshot") return readSnapshot({ cwd, token: args.includes("--token") ? valueAfter(args, "--token") : undefined });
  throw new Error(`unknown command: ${command || "<empty>"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
