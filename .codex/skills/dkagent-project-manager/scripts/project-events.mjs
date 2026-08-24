#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const EVENT_FIELDS = new Set(["taskId", "action", "module", "summary", "status", "dependencies", "evidence", "discoveredTodos"]);
const STORED_EVENT_FIELDS = new Set(["schemaVersion", "eventId", ...EVENT_FIELDS, "worktreePath", "branch", "headSha", "createdAt"]);
const STATE_FIELDS = new Set(["schemaVersion", "processedEventIds", "activeClaims", "documentHashes", "lastSynchronizedAt"]);
const ACTIONS = new Set(["started", "finished", "blocked", "discovered"]);
const STATUSES = new Set(["in_progress", "completed", "needs_verification", "blocked"]);
const EXECUTION_EVIDENCE = new Set(["test", "typecheck", "build"]);
const EVIDENCE_KINDS = new Set(["test", "typecheck", "build", "commit", "user_confirmation"]);
const EVIDENCE_FIELDS = new Set(["kind", "summary", "command", "exitCode"]);
const DISCOVERED_FIELDS = new Set(["summary", "module", "reason"]);
const DOCUMENTS = ["AGENTS.md", "docs/project/STATUS.md", "docs/project/BACKLOG.md"];
const PROJECT_TASK_PREFIX = "- [project-task] ";
const PROJECT_EVENT_PREFIX = "- [project-event] ";
const SECRET_ASSIGNMENT = /\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*=\s*\S+/i;
const BEARER_TOKEN = /\bBearer\s+\S+/i;
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]+\b/i;
const SHELL_CONSTRUCT = /[;|&()`<>'"\\]/;
const SENSITIVE_HEADER = /\b(?:x-)?api-key\s*:\s*\S+|\bauthorization\s*:\s*\S+/i;
const SENSITIVE_FLAG = /(?:^|\s)--[a-z0-9-]*(?:api-key|apikey|token|secret|password|passphrase|authorization|auth|credential|private-key)[a-z0-9-]*(?:\s+\S+|=\S+|$)/i;
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const ENVIRONMENT_ASSIGNMENT_TOKEN = /[A-Za-z_][A-Za-z0-9_]*=/;
const PATH_TOKEN = /^(?:\/|\.{1,2}\/)?[A-Za-z0-9_./*-]+$/;
const TEST_PATH = /\.test\.[cm]?[jt]s$/;
const NODE_CHECK_PATH = /\.[cm]?js$/;
const TASK_ID = /^DKA-[A-Z0-9][A-Z0-9-]{2,63}$/;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESSED_EVENT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DOCUMENT_HASH = /^[0-9a-f]{64}$/;
const LOCK_FILE = "aggregate.lock";
const LOCK_CREATING_PREFIX = "aggregate.lock.creating-";
const LOCK_RECOVERY_PREFIX = "aggregate.lock.recovery-";
const LOCK_INTENT_PREFIX = "aggregate.intent-";
const LOCK_INTENT_CREATING_PREFIX = "aggregate.intent.creating-";
const ACK_CLEANUP_TOMBSTONE_PREFIX = "aggregate.ack-cleanup.tombstone-";
const ACK_INTENT_FILE = "ack-intent.json";
const ACK_INTENT_FIELDS = new Set(["schemaVersion", "lockOwner", "eventIds", "expectedDocumentHashes", "baselineHashes", "createdAt"]);
const ACK_LOCK_OWNER_FIELDS = new Set(["token", "pid", "acquiredAt"]);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function canonicalExistingPath(value) {
  return realpathSync(path.resolve(value));
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

function writeJsonExclusiveAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    linkSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
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
    && owner.pid > 0
    && typeof owner.acquiredAt === "string"
    && !Number.isNaN(Date.parse(owner.acquiredAt))
    && validDocumentHashes(owner.baselineHashes);
}

function validAckIntent(intent) {
  return intent
    && typeof intent === "object"
    && !Array.isArray(intent)
    && Object.keys(intent).length === ACK_INTENT_FIELDS.size
    && Object.keys(intent).every((key) => ACK_INTENT_FIELDS.has(key))
    && intent.schemaVersion === 1
    && intent.lockOwner
    && typeof intent.lockOwner === "object"
    && !Array.isArray(intent.lockOwner)
    && Object.keys(intent.lockOwner).length === ACK_LOCK_OWNER_FIELDS.size
    && Object.keys(intent.lockOwner).every((key) => ACK_LOCK_OWNER_FIELDS.has(key))
    && EVENT_ID.test(intent.lockOwner.token)
    && Number.isInteger(intent.lockOwner.pid)
    && intent.lockOwner.pid > 0
    && typeof intent.lockOwner.acquiredAt === "string"
    && !Number.isNaN(Date.parse(intent.lockOwner.acquiredAt))
    && Array.isArray(intent.eventIds)
    && intent.eventIds.length > 0
    && intent.eventIds.every((eventId) => typeof eventId === "string" && EVENT_ID.test(eventId))
    && new Set(intent.eventIds).size === intent.eventIds.length
    && intent.eventIds.every((eventId, index) => index === 0 || intent.eventIds[index - 1].localeCompare(eventId) < 0)
    && validDocumentHashes(intent.expectedDocumentHashes)
    && validDocumentHashes(intent.baselineHashes)
    && typeof intent.createdAt === "string"
    && !Number.isNaN(Date.parse(intent.createdAt));
}

function ackIntentRecord(root) {
  const file = path.join(root, ACK_INTENT_FILE);
  if (!existsSync(file)) return { exists: false, intent: null };
  try {
    const intent = readJson(file);
    return { exists: true, intent: validAckIntent(intent) ? intent : null };
  } catch {
    return { exists: true, intent: null };
  }
}

function sameLockOwnerIdentity(identity, owner) {
  return Boolean(owner)
    && identity.token === owner.token
    && identity.pid === owner.pid
    && identity.acquiredAt === owner.acquiredAt;
}

function sameEventIds(left, right) {
  return left.length === right.length && left.every((eventId, index) => eventId === right[index]);
}

function ackIntentMatchesRequest(intent, owner, eventIds, expectedDocumentHashes) {
  return sameLockOwnerIdentity(intent.lockOwner, owner)
    && sameEventIds(intent.eventIds, [...eventIds].sort())
    && sameDocumentHashes(intent.expectedDocumentHashes, expectedDocumentHashes)
    && sameDocumentHashes(intent.baselineHashes, owner.baselineHashes);
}

function ensureAckIntent(root, owner, eventIds, expectedDocumentHashes) {
  const existing = ackIntentRecord(root);
  if (existing.exists) {
    if (!existing.intent) throw new Error("ACK intent is invalid; manual inspection required");
    if (!ackIntentMatchesRequest(existing.intent, owner, eventIds, expectedDocumentHashes)) {
      throw new Error("ACK intent does not match lock owner, event IDs, or document hashes");
    }
    return existing.intent;
  }
  const intent = {
    schemaVersion: 1,
    lockOwner: { token: owner.token, pid: owner.pid, acquiredAt: owner.acquiredAt },
    eventIds: [...eventIds].sort(),
    expectedDocumentHashes,
    baselineHashes: owner.baselineHashes,
    createdAt: new Date().toISOString(),
  };
  try {
    writeJsonExclusiveAtomic(path.join(root, ACK_INTENT_FILE), intent);
    return intent;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const raced = ackIntentRecord(root);
    if (!raced.intent || !ackIntentMatchesRequest(raced.intent, owner, eventIds, expectedDocumentHashes)) {
      throw new Error("ACK intent does not match lock owner, event IDs, or document hashes");
    }
    return raced.intent;
  }
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
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return false;
  const fields = intent.operation === "ack"
    ? ["operation", "token", "pid", "createdAt", "lockToken", "eventIds", "expectedDocumentHashes"]
    : intent.operation === "adopt"
      ? ["operation", "token", "pid", "createdAt", "lockToken"]
      : ["operation", "token", "pid", "createdAt"];
  return new Set(["ack", "adopt", "release", "recover"]).has(intent.operation)
    && Object.keys(intent).length === fields.length
    && Object.keys(intent).every((key) => fields.includes(key))
    && EVENT_ID.test(intent.token)
    && Number.isSafeInteger(intent.pid)
    && intent.pid > 0
    && intent.pid <= 2147483647
    && typeof intent.createdAt === "string"
    && !Number.isNaN(Date.parse(intent.createdAt))
    && ((intent.operation !== "ack" && intent.operation !== "adopt")
      || (typeof intent.lockToken === "string" && EVENT_ID.test(intent.lockToken)))
    && (intent.operation !== "ack"
      || (Array.isArray(intent.eventIds)
        && intent.eventIds.length > 0
        && intent.eventIds.every((eventId) => typeof eventId === "string" && EVENT_ID.test(eventId))
        && new Set(intent.eventIds).size === intent.eventIds.length
        && intent.eventIds.every((eventId, index) => index === 0 || intent.eventIds[index - 1].localeCompare(eventId) < 0)
        && validDocumentHashes(intent.expectedDocumentHashes)));
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
    // Unknown probe failures are not proof that the lifecycle process is dead.
    return true;
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

function createLifecycleIntent(root, operation, { lockToken, eventIds, expectedDocumentHashes } = {}) {
  const requiresLockToken = operation === "ack" || operation === "adopt";
  if (requiresLockToken && (typeof lockToken !== "string" || !EVENT_ID.test(lockToken))) {
    throw new Error("invalid lifecycle lock token");
  }
  if (operation === "ack"
    && (!Array.isArray(eventIds)
      || eventIds.length === 0
      || new Set(eventIds).size !== eventIds.length
      || eventIds.some((eventId) => typeof eventId !== "string" || !EVENT_ID.test(eventId))
      || eventIds.some((eventId, index) => index > 0 && eventIds[index - 1].localeCompare(eventId) >= 0)
      || !validDocumentHashes(expectedDocumentHashes))) {
    throw new Error("invalid ACK lifecycle request");
  }
  const intent = {
    operation,
    token: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...(requiresLockToken ? { lockToken } : {}),
    ...(operation === "ack" ? { eventIds, expectedDocumentHashes } : {}),
  };
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

function sameAckLifecycleRequest(intent, request) {
  return intent.lockToken === request.lockToken
    && sameEventIds(intent.eventIds, request.eventIds)
    && sameDocumentHashes(intent.expectedDocumentHashes, request.expectedDocumentHashes);
}

function deadAckTakeoverEligible(root, intent, owner, request, processAlive = isProcessAlive(intent.pid)) {
  if (intent.operation !== "ack"
    || owner?.token !== request.lockToken
    || !sameAckLifecycleRequest(intent, request)
    || processAlive) {
    return false;
  }
  const ackRecord = ackIntentRecord(root);
  return !ackRecord.exists
    || (ackRecord.intent
      && ackRecord.intent.lockOwner.token === request.lockToken
      && sameLockOwnerIdentity(ackRecord.intent.lockOwner, owner)
      && sameEventIds(ackRecord.intent.eventIds, request.eventIds)
      && sameDocumentHashes(ackRecord.intent.expectedDocumentHashes, request.expectedDocumentHashes));
}

function assertExclusiveLifecycleIntent(root, marker, { ackRequest } = {}) {
  const diagnostics = lockDiagnostics(root);
  if (!hasOtherLifecycleIntent(diagnostics, marker)) return [];
  const otherNames = diagnostics.intentMarkers.filter((name) => name !== path.basename(marker));
  if (!ackRequest) throw new Error("aggregate lifecycle operation is in progress");
  const owner = readLockOwner(path.join(root, LOCK_FILE));
  const mayTakeOver = otherNames.every((name) => {
    const intent = readLifecycleIntent(path.join(root, name));
    return intent && deadAckTakeoverEligible(root, intent, owner, ackRequest);
  });
  if (!mayTakeOver) throw new Error("aggregate lifecycle operation is in progress");
  return otherNames.map((name) => path.join(root, name));
}

function terminateTestProcess(requestedPhase, signal, phase) {
  if (requestedPhase !== phase) return;
  if (signal === "SIGKILL") process.kill(process.pid, "SIGKILL");
  process.exit(86);
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

function evidenceCommandKind(tokens) {
  const [executable, subcommand] = tokens;
  if (executable === "npm") {
    if (tokens.length === 2 && subcommand === "test") return "test";
    if (tokens.length === 3 && subcommand === "run") {
      const script = tokens[2];
      if (script === "test" || script.startsWith("test:")) return "test";
      if (script === "typecheck" || script.startsWith("typecheck:")) return "typecheck";
      if (script === "build" || script.startsWith("build:")) return "build";
    }
  }
  if (executable === "node" && subcommand === "--test" && areTestPaths(tokens.slice(2))) return "test";
  if (executable === "tsx" && subcommand === "--test" && areTestPaths(tokens.slice(2))) return "test";
  if (executable === "npx") {
    if (subcommand === "tsx" && tokens[2] === "--test" && areTestPaths(tokens.slice(3))) return "test";
    if (tokens.length === 3 && subcommand === "tsc" && tokens[2] === "--noEmit") return "typecheck";
    if (tokens.length === 3 && subcommand === "vitest" && tokens[2] === "--run") return "test";
  }
  return null;
}

function isUnsafeSimpleCommand(command) {
  if (SHELL_CONSTRUCT.test(command) || SENSITIVE_FLAG.test(command)) {
    return true;
  }
  const tokens = command.trim().split(/\s+/);
  return tokens.some((token) => ENVIRONMENT_ASSIGNMENT_TOKEN.test(token)) || !isAllowedValidationCommand(tokens);
}

function validateStoredText(value, field, maximumLength, { singleLine = true, command = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > maximumLength) throw new Error(`${field} text is too long`);
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${field} must be a single line`);
  if (MARKDOWN_HEADING.test(value)) throw new Error(`${field} must not be a Markdown heading`);
  if (containsHighConfidenceCredential(value) || (command && isUnsafeSimpleCommand(value))) {
    throw new Error("unsafe text content");
  }
}

function hasSuccessfulBehaviorEvidence(evidence) {
  return evidence.some(
    (item) => item.kind === "user_confirmation" || (EXECUTION_EVIDENCE.has(item.kind) && item.exitCode === 0),
  );
}

export function stateRoot(cwd) {
  const worktree = canonicalExistingPath(cwd);
  const commonDirectory = canonicalExistingPath(path.resolve(worktree, git(worktree, ["rev-parse", "--git-common-dir"])));
  return path.join(commonDirectory, "dkagent-project-manager");
}

export function initStore({ cwd, managementWorktree, managementBranch = "main" }) {
  const root = stateRoot(cwd);
  if (existsSync(path.join(root, "config.json"))) throw new Error("project manager store already initialized");

  const resolved = canonicalExistingPath(managementWorktree);
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
  if (!TASK_ID.test(input.taskId)) throw new Error("taskId must use canonical format");
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
  for (const dependency of input.dependencies) {
    validateStoredText(dependency, "dependency", 128);
    if (!TASK_ID.test(dependency)) throw new Error("dependency must use canonical format");
  }
  for (const evidence of input.evidence) {
    for (const key of Object.keys(evidence)) {
      if (!EVIDENCE_FIELDS.has(key)) throw new Error(`unknown evidence field: ${key}`);
    }
    if (!EVIDENCE_KINDS.has(evidence.kind) || typeof evidence.summary !== "string" || !evidence.summary.trim()) {
      throw new Error("invalid evidence item");
    }
    validateStoredText(evidence.summary, "evidence summary", 500);
    if (!EXECUTION_EVIDENCE.has(evidence.kind) && (evidence.command !== undefined || evidence.exitCode !== undefined)) {
      throw new Error("non-execution evidence cannot contain command or exitCode");
    }
    if (EXECUTION_EVIDENCE.has(evidence.kind) && evidence.command === undefined) {
      throw new Error("evidence command is required");
    }
    if (evidence.command !== undefined) {
      validateStoredText(evidence.command, "command", 1000, { singleLine: true, command: true });
      if (evidenceCommandKind(evidence.command.trim().split(/\s+/)) !== evidence.kind) {
        throw new Error("evidence kind does not match command");
      }
    }
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
}

export function emitEvent({ cwd, input }) {
  validateInput(input);
  const root = stateRoot(cwd);
  if (!existsSync(path.join(root, "config.json"))) throw new Error("project manager store is not initialized");

  const normalizedInput = input.status === "completed" && !hasSuccessfulBehaviorEvidence(input.evidence)
    ? { ...input, status: "needs_verification" }
    : input;
  const event = {
    schemaVersion: 1,
    eventId: randomUUID(),
    ...normalizedInput,
    worktreePath: canonicalExistingPath(cwd),
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
  const sourceFactsAreValid = event
    && event.schemaVersion === 1
    && event.eventId === eventId
    && typeof event.worktreePath === "string"
    && Boolean(event.worktreePath)
    && typeof event.branch === "string"
    && Boolean(event.branch)
    && typeof event.headSha === "string"
    && GIT_SHA.test(event.headSha)
    && typeof event.createdAt === "string"
    && !Number.isNaN(Date.parse(event.createdAt))
    && Object.keys(event).length === STORED_EVENT_FIELDS.size
    && [...STORED_EVENT_FIELDS].every((field) => Object.hasOwn(event, field));
  if (!sourceFactsAreValid) return false;
  try {
    validateInput(Object.fromEntries([...EVENT_FIELDS].map((field) => [field, event[field]])));
    return true;
  } catch {
    return false;
  }
}

function applyActiveClaim(activeClaims, event) {
  const claims = new Set(activeClaims[event.taskId] ?? []);
  if (event.action === "started" && event.status === "in_progress") claims.add(event.worktreePath);
  if (event.action === "finished" || event.action === "blocked") claims.delete(event.worktreePath);
  if (claims.size) activeClaims[event.taskId] = [...claims].sort();
  else delete activeClaims[event.taskId];
}

function readProcessedEvents(root) {
  const processed = path.join(root, "events", "processed");
  const events = [];
  for (const name of readdirSync(processed).filter((entry) => entry.endsWith(".json")).sort()) {
    const eventId = name.slice(0, -".json".length);
    if (!EVENT_ID.test(eventId)) continue;
    try {
      const event = readJson(path.join(processed, name));
      if (isStoredEvent(event, eventId)) events.push(event);
    } catch {
      // Ordinary snapshots reconcile valid history; terminal ACK cleanup audits every entry strictly.
    }
  }
  return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
}

function validPersistedState(state) {
  return state
    && typeof state === "object"
    && !Array.isArray(state)
    && Object.keys(state).length === STATE_FIELDS.size
    && [...STATE_FIELDS].every((field) => Object.hasOwn(state, field))
    && state.schemaVersion === 1
    && Array.isArray(state.processedEventIds)
    && state.processedEventIds.every((eventId) => typeof eventId === "string" && EVENT_ID.test(eventId))
    && new Set(state.processedEventIds).size === state.processedEventIds.length
    && state.activeClaims
    && typeof state.activeClaims === "object"
    && !Array.isArray(state.activeClaims)
    && Object.entries(state.activeClaims).every(([taskId, worktrees]) => (
      TASK_ID.test(taskId)
      && Array.isArray(worktrees)
      && worktrees.length > 0
      && worktrees.every((worktree) => typeof worktree === "string" && Boolean(worktree))
      && new Set(worktrees).size === worktrees.length
    ))
    && validDocumentHashes(state.documentHashes)
    && (state.lastSynchronizedAt === null
      || (typeof state.lastSynchronizedAt === "string" && !Number.isNaN(Date.parse(state.lastSynchronizedAt))));
}

function auditProcessedDirectory(root) {
  const processed = path.join(root, "events", "processed");
  const reasons = [];
  const events = [];
  for (const entry of readdirSync(processed, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const match = PROCESSED_EVENT_FILE.exec(entry.name);
    if (!match) {
      reasons.push(`processed directory entry is not a canonical UUID.json file: ${entry.name}`);
      continue;
    }
    if (!entry.isFile()) {
      reasons.push(`processed directory entry is not a regular file: ${entry.name}`);
      continue;
    }
    const eventId = match[1];
    try {
      const event = readJson(path.join(processed, entry.name));
      if (!isStoredEvent(event, eventId)) reasons.push(`processed event is invalid or mismatched: ${entry.name}`);
      else events.push(event);
    } catch {
      reasons.push(`processed event JSON is malformed: ${entry.name}`);
    }
  }
  events.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
  const activeClaims = {};
  for (const event of events) applyActiveClaim(activeClaims, event);
  return { reasons, events, processedEventIds: events.map((event) => event.eventId), activeClaims };
}

function reconcileProcessedState(root, state) {
  const events = readProcessedEvents(root);
  const activeClaims = {};
  for (const event of events) applyActiveClaim(activeClaims, event);
  const recordedIds = new Set(Array.isArray(state.processedEventIds) ? state.processedEventIds : []);
  return {
    state: { ...state, processedEventIds: events.map((event) => event.eventId), activeClaims },
    recoveryEvents: events.filter((event) => !recordedIds.has(event.eventId)),
  };
}

function ackIntentRecoveryReasons(root, config, persistedState, intent, owner) {
  const reasons = [];
  if (!sameLockOwnerIdentity(intent.lockOwner, owner)) reasons.push("ACK intent lock owner changed");
  if (!owner || !sameDocumentHashes(intent.baselineHashes, owner.baselineHashes)) reasons.push("ACK intent baseline differs from lock owner");
  if (!existsSync(config.managementWorktree)) reasons.push("management worktree is missing");
  else {
    const branch = git(config.managementWorktree, ["branch", "--show-current"]);
    if (branch !== config.managementBranch) reasons.push(`management branch mismatch: ${branch || "detached"}`);
    if (!sameDocumentHashes(documentHashes(config.managementWorktree), intent.expectedDocumentHashes)) {
      reasons.push("management document hashes differ from ACK intent");
    }
  }
  const baselineState = sameDocumentHashes(persistedState.documentHashes, intent.baselineHashes);
  const committedState = sameDocumentHashes(persistedState.documentHashes, intent.expectedDocumentHashes)
    && Array.isArray(persistedState.processedEventIds)
    && intent.eventIds.every((eventId) => persistedState.processedEventIds.includes(eventId));
  if (!baselineState && !committedState) reasons.push("persisted state does not match ACK intent phase");
  return reasons;
}

function ackMarkerMatchesIntent(marker, intent) {
  return marker.operation === "ack"
    && marker.lockToken === intent.lockOwner.token
    && sameEventIds(marker.eventIds, intent.eventIds)
    && sameDocumentHashes(marker.expectedDocumentHashes, intent.expectedDocumentHashes);
}

function ackCleanupEntries(root) {
  const diagnostics = lockDiagnostics(root);
  const tombstones = readdirSync(root)
    .filter((name) => name.startsWith(ACK_CLEANUP_TOMBSTONE_PREFIX))
    .sort();
  return [
    ...diagnostics.intentMarkers.map((name) => ({ name, file: path.join(root, name), tombstone: false })),
    ...tombstones.map((name) => ({ name, file: path.join(root, name), tombstone: true })),
  ];
}

function ackCleanupReasons(root, config, persistedState, intent, { allowedLiveMarker } = {}) {
  const reasons = [];
  if (existsSync(path.join(root, LOCK_FILE))) reasons.push("aggregate lock still exists");
  if (!existsSync(config.managementWorktree)) reasons.push("management worktree is missing");
  else {
    const branch = git(config.managementWorktree, ["branch", "--show-current"]);
    if (branch !== config.managementBranch) reasons.push(`management branch mismatch: ${branch || "detached"}`);
    if (!sameDocumentHashes(documentHashes(config.managementWorktree), intent.expectedDocumentHashes)) {
      reasons.push("management document hashes differ from ACK intent");
    }
  }
  if (!sameDocumentHashes(persistedState?.documentHashes, intent.expectedDocumentHashes)) {
    reasons.push("persisted state hashes differ from ACK intent");
  }
  const audit = auditProcessedDirectory(root);
  reasons.push(...audit.reasons);
  if (!validPersistedState(persistedState)) {
    reasons.push("persisted state schema is invalid");
  }
  if (!isDeepStrictEqual(persistedState?.processedEventIds, audit.processedEventIds)) {
    reasons.push("persisted processedEventIds differ from canonical processed audit");
  }
  if (!isDeepStrictEqual(persistedState?.activeClaims, audit.activeClaims)) {
    reasons.push("persisted activeClaims differ from canonical processed audit");
  }
  if (!Array.isArray(persistedState?.processedEventIds)
    || intent.eventIds.some((eventId) => !persistedState.processedEventIds.includes(eventId))) {
    reasons.push("persisted state is missing ACK event IDs");
  }
  const eventsById = new Map(audit.events.map((event) => [event.eventId, event]));
  const events = [];
  for (const eventId of intent.eventIds) {
    const pending = path.join(root, "events", "pending", `${eventId}.json`);
    if (existsSync(pending)) reasons.push(`ACK event is still pending: ${eventId}`);
    const event = eventsById.get(eventId);
    if (!event) reasons.push(`processed ACK event is invalid or missing: ${eventId}`);
    else events.push(event);
  }
  if (existsSync(config.managementWorktree)) {
    const currentBlocks = currentProjectionBlocks(config.managementWorktree);
    for (const event of latestEventsByTask(events)) {
      const taskBlocks = currentBlocks.filter((block) => block.taskId === event.taskId);
      const expected = projectionBlock(event);
      if (taskBlocks.length !== 1
        || taskBlocks[0].taskLine !== expected.taskLine
        || taskBlocks[0].projectionLine !== expected.projectionLine) {
        reasons.push(`ACK event projection changed: ${event.taskId}`);
      }
    }
  }
  for (const entry of ackCleanupEntries(root)) {
    const marker = readLifecycleIntent(entry.file);
    if (!marker || !ackMarkerMatchesIntent(marker, intent)) {
      reasons.push(`unrelated or invalid lifecycle marker blocks ACK cleanup: ${entry.name}`);
      continue;
    }
    if (entry.file !== allowedLiveMarker && isProcessAlive(marker.pid)) {
      reasons.push(`live lifecycle marker blocks ACK cleanup: ${entry.name}`);
    }
  }
  return reasons;
}

function completeAckCleanup(root, config, persistedState, intent, {
  allowedLiveMarker,
  _testTerminateAfterRenameCount,
  _testTerminationSignal,
} = {}) {
  const initialReasons = ackCleanupReasons(root, config, persistedState, intent, { allowedLiveMarker });
  if (initialReasons.length) throw new Error(`ACK cleanup is unsafe: ${initialReasons.join("; ")}`);
  let renameCount = 0;
  while (true) {
    const entries = ackCleanupEntries(root);
    if (!entries.length) break;
    const entry = entries[0];
    const marker = readLifecycleIntent(entry.file);
    if (!marker || !ackMarkerMatchesIntent(marker, intent)) {
      throw new Error(`ACK cleanup is unsafe: unrelated or invalid lifecycle marker: ${entry.name}`);
    }
    if (entry.file !== allowedLiveMarker && isProcessAlive(marker.pid)) {
      throw new Error(`ACK cleanup is unsafe: live lifecycle marker: ${entry.name}`);
    }
    if (entry.tombstone) {
      rmSync(entry.file, { force: true });
      continue;
    }
    const tombstone = path.join(root, `${ACK_CLEANUP_TOMBSTONE_PREFIX}${randomUUID()}`);
    try {
      renameSync(entry.file, tombstone);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    renameCount += 1;
    if (_testTerminateAfterRenameCount === renameCount) {
      terminateTestProcess("cleanup-rename", _testTerminationSignal, "cleanup-rename");
    }
    rmSync(tombstone, { force: true });
  }
  const finalReasons = ackCleanupReasons(root, config, persistedState, intent);
  if (finalReasons.length) throw new Error(`ACK cleanup is unsafe: ${finalReasons.join("; ")}`);
  try {
    unlinkSync(path.join(root, ACK_INTENT_FILE));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return true;
}

function targetStatus(root, config, state, persistedState, intentRecord) {
  if (intentRecord.exists) {
    if (!intentRecord.intent) {
      return { safe: false, reasons: ["ACK intent is invalid"], managementWorktree: config.managementWorktree };
    }
    const owner = readLockOwner(path.join(root, LOCK_FILE));
    if (!existsSync(path.join(root, LOCK_FILE))) {
      const reasons = ackCleanupReasons(root, config, persistedState, intentRecord.intent);
      return {
        safe: reasons.length === 0,
        reasons,
        managementWorktree: config.managementWorktree,
        ...(reasons.length === 0 ? { recoveryMode: "ack_cleanup" } : {}),
      };
    }
    const reasons = ackIntentRecoveryReasons(root, config, persistedState, intentRecord.intent, owner);
    return {
      safe: reasons.length === 0,
      reasons,
      managementWorktree: config.managementWorktree,
      ...(reasons.length === 0 ? { recoveryMode: "ack_intent" } : {}),
    };
  }
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
  const taskConflicts = [...byTask]
    .filter(([, worktrees]) => worktrees.size > 1)
    .map(([taskId, worktrees]) => ({
      kind: "task_claimed_by_multiple_worktrees",
      taskId,
      worktrees: [...worktrees].sort(),
    }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const byWorktree = new Map();
  for (const [taskId, worktrees] of byTask) {
    for (const worktreePath of worktrees) {
      const taskIds = byWorktree.get(worktreePath) ?? [];
      taskIds.push(taskId);
      byWorktree.set(worktreePath, taskIds);
    }
  }
  const worktreeConflicts = [...byWorktree]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([worktreePath, taskIds]) => ({
      kind: "worktree_claims_multiple_tasks",
      worktreePath,
      taskIds: taskIds.sort(),
    }))
    .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath));
  return [...taskConflicts, ...worktreeConflicts];
}

function canonicalEventPayload(event) {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    taskId: event.taskId,
    action: event.action,
    status: event.status,
    module: event.module,
    summary: event.summary,
    dependencies: [...event.dependencies],
    evidence: event.evidence.map((item) => {
      const evidence = { kind: item.kind, summary: item.summary };
      if (item.command !== undefined) evidence.command = item.command;
      if (item.exitCode !== undefined) evidence.exitCode = item.exitCode;
      return evidence;
    }),
    discoveredTodos: event.discoveredTodos.map((item) => ({
      summary: item.summary,
      module: item.module,
      reason: item.reason,
    })),
    worktreePath: event.worktreePath,
    branch: event.branch,
    headSha: event.headSha,
    createdAt: event.createdAt,
  };
}

function projectionBlock(event) {
  const taskLine = `${PROJECT_TASK_PREFIX}${JSON.stringify({
    taskId: event.taskId,
    status: event.status,
    module: event.module,
    summary: event.summary,
    worktreePath: event.worktreePath,
    branch: event.branch,
    headSha: event.headSha,
    createdAt: event.createdAt,
  })}`;
  const payload = canonicalEventPayload(event);
  const projectionLine = `${PROJECT_EVENT_PREFIX}${JSON.stringify({
    digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    payload,
  })}`;
  return { eventId: event.eventId, taskLine, projectionLine, block: `${taskLine}\n${projectionLine}` };
}

function readStoredEvent(root, eventId) {
  const pending = path.join(root, "events", "pending", `${eventId}.json`);
  const processed = path.join(root, "events", "processed", `${eventId}.json`);
  if (!existsSync(pending) && !existsSync(processed)) throw new Error(`event not found: ${eventId}`);
  const event = readJson(existsSync(pending) ? pending : processed);
  if (!isStoredEvent(event, eventId)) throw new Error(`invalid stored event: ${eventId}`);
  return event;
}

export function renderEventProjections({ cwd, token, eventIds }) {
  const root = stateRoot(cwd);
  requireToken(root, token);
  if (!Array.isArray(eventIds) || eventIds.length === 0 || eventIds.some((eventId) => typeof eventId !== "string" || !EVENT_ID.test(eventId))) {
    throw new Error("invalid event ID");
  }
  const events = eventIds.map((eventId) => readStoredEvent(root, eventId));
  return { schemaVersion: 1, blocks: latestEventsByTask(events).map((event) => projectionBlock(event)) };
}

function currentProjectionBlocks(managementWorktree) {
  const blocks = [];
  for (const relative of ["docs/project/STATUS.md", "docs/project/BACKLOG.md"]) {
    const file = path.join(managementWorktree, relative);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (!lines[index].startsWith(PROJECT_TASK_PREFIX) || !lines[index + 1].startsWith(PROJECT_EVENT_PREFIX)) continue;
      let human;
      try {
        human = JSON.parse(lines[index].slice(PROJECT_TASK_PREFIX.length));
      } catch {
        continue;
      }
      if (!human || typeof human.taskId !== "string") continue;
      blocks.push({ taskId: human.taskId, taskLine: lines[index], projectionLine: lines[index + 1] });
    }
  }
  return blocks;
}

function sortEventsByCreation(events) {
  return [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
}

function latestEventsByTask(events) {
  const latest = new Map();
  for (const event of sortEventsByCreation(events)) latest.set(event.taskId, event);
  return [...latest.values()];
}

export function acquireLock({ cwd }) {
  const root = stateRoot(cwd);
  if (existsSync(path.join(root, ACK_INTENT_FILE))) {
    throw new Error("ACK intent blocks new lock acquisition");
  }
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
    assertExclusiveLifecycleIntent(root, marker);
    if (existsSync(path.join(root, ACK_INTENT_FILE))) {
      throw new Error("ACK intent must be completed before releasing its owner");
    }
    return removeOwnedLockUnderLifecycle(root, token);
  } finally {
    removeLifecycleIntent(marker);
  }
}

function removeOwnedLockUnderLifecycle(root, token) {
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
  if (diagnostics.intentMarkers.length) {
    result.intentMarkers = diagnostics.intentMarkers;
    result.lifecycleIntents = diagnostics.intentMarkers.map((name) => {
      const intent = readLifecycleIntent(path.join(root, name));
      if (!intent) return { name, valid: false, takeoverEligible: false };
      const processAlive = isProcessAlive(intent.pid);
      return {
        name,
        valid: true,
        ...intent,
        processAlive,
        takeoverEligible: deadAckTakeoverEligible(root, intent, status.owner, intent, processAlive),
      };
    });
  }
  if (diagnostics.intentCreatingFiles.length) result.intentCreatingFiles = diagnostics.intentCreatingFiles;
  const cleanupTombstones = readdirSync(root)
    .filter((name) => name.startsWith(ACK_CLEANUP_TOMBSTONE_PREFIX))
    .sort();
  if (cleanupTombstones.length) result.ackCleanupTombstones = cleanupTombstones;
  const intentRecord = ackIntentRecord(root);
  if (intentRecord.exists) {
    result.ackIntentExists = true;
    if (intentRecord.intent && !existsSync(lock)) {
      const config = readJson(path.join(root, "config.json"));
      let persistedState = null;
      try {
        persistedState = readJson(path.join(root, "state.json"));
      } catch {
        // The strict cleanup reasons report an invalid persisted state without hiding the journal.
      }
      const reasons = ackCleanupReasons(root, config, persistedState, intentRecord.intent);
      result.ackCleanup = { safe: reasons.length === 0, reasons, eventIds: intentRecord.intent.eventIds };
      if (reasons.length === 0) result.recoveryMode = "ack_cleanup";
    }
  }
  return result;
}

export function recoverLock({ cwd, confirm = false }) {
  const root = stateRoot(cwd);
  const lock = path.join(root, LOCK_FILE);
  const marker = createLifecycleIntent(root, "recover");
  try {
    assertExclusiveLifecycleIntent(root, marker);
    const diagnostics = lockDiagnostics(root);
    const currentOwner = readLockOwner(lock);
    if (currentOwner) throw new Error("aggregate lock owner exists; release requires token");
    if (diagnostics.blockingTombstones.length) {
      throw new Error("owned recovery tombstone blocks aggregation; manual inspection required");
    }
    if (!existsSync(lock)) {
      if (!diagnostics.creatingFiles.length) {
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
    const tombstoneOwner = readLockOwner(tombstone);
    if (tombstoneOwner) throw new Error("lock recovery found an owner; tombstone retained");
    rmSync(tombstone, { recursive: true });
    return true;
  } finally {
    removeLifecycleIntent(marker);
  }
}

export function recoverAckCleanup({
  cwd,
  confirm = false,
  _testTerminateAfterRenameCount,
  _testTerminationSignal,
}) {
  if (confirm !== true) throw new Error("ACK cleanup recovery requires explicit confirmation");
  const root = stateRoot(cwd);
  const intentRecord = ackIntentRecord(root);
  if (!intentRecord.exists) throw new Error("ACK cleanup journal is missing");
  if (!intentRecord.intent) throw new Error("ACK cleanup journal is invalid; manual inspection required");
  const config = readJson(path.join(root, "config.json"));
  let persistedState = null;
  try {
    persistedState = readJson(path.join(root, "state.json"));
  } catch {
    // completeAckCleanup reports the invalid state and keeps the durable journal.
  }
  return completeAckCleanup(root, config, persistedState, intentRecord.intent, {
    _testTerminateAfterRenameCount,
    _testTerminationSignal,
  });
}

function readPendingEvents(root) {
  const pending = path.join(root, "events", "pending");
  return readdirSync(pending)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(pending, name)));
}

export function readSnapshot({ cwd, token } = {}) {
  const root = stateRoot(cwd);
  if (token) requireToken(root, token);
  const events = readPendingEvents(root);
  const config = readJson(path.join(root, "config.json"));
  const intentRecord = ackIntentRecord(root);
  let persistedState;
  try {
    persistedState = readJson(path.join(root, "state.json"));
  } catch (error) {
    if (!intentRecord.intent || existsSync(path.join(root, LOCK_FILE))) throw error;
    persistedState = null;
  }
  const { state, recoveryEvents } = persistedState
    ? reconcileProcessedState(root, persistedState)
    : { state: null, recoveryEvents: [] };
  return {
    config,
    state,
    events,
    recoveryEvents,
    ackIntentExists: intentRecord.exists,
    ackIntent: intentRecord.intent,
    ackRecoveryEventIds: intentRecord.intent?.eventIds ?? [],
    conflicts: state ? activeClaimConflicts(state, events) : [],
    target: targetStatus(root, config, state, persistedState, intentRecord),
  };
}

export function ackEvents({
  cwd,
  token,
  eventIds,
  expectedDocumentHashes,
  _testCrashAfterPhase,
  _testTerminateAfterPhase,
  _testTerminationSignal,
  _testAfterLifecycleAcquired,
  _testBeforeStateWrite,
}) {
  if (typeof token !== "string" || !EVENT_ID.test(token)) throw new Error("invalid lifecycle lock token");
  if (!Array.isArray(eventIds)
    || eventIds.length === 0
    || new Set(eventIds).size !== eventIds.length
    || eventIds.some((eventId) => typeof eventId !== "string" || !EVENT_ID.test(eventId))) {
    throw new Error("invalid event ID");
  }
  if (!validDocumentHashes(expectedDocumentHashes)) throw new Error("invalid expected document hashes");
  eventIds = [...eventIds].sort();
  expectedDocumentHashes = Object.fromEntries(DOCUMENTS.map((relative) => [relative, expectedDocumentHashes[relative]]));
  const ackRequest = { lockToken: token, eventIds, expectedDocumentHashes };
  const root = stateRoot(cwd);
  const marker = createLifecycleIntent(root, "ack", ackRequest);
  try {
    assertExclusiveLifecycleIntent(root, marker, { ackRequest });
    terminateTestProcess(_testTerminateAfterPhase, _testTerminationSignal, "lifecycle");
    _testAfterLifecycleAcquired?.();
    const owner = requireToken(root, token);
    const config = readJson(path.join(root, "config.json"));
    const stateFile = path.join(root, "state.json");
    const persistedState = readJson(stateFile);
    const { state, recoveryEvents } = reconcileProcessedState(root, persistedState);
    if (!existsSync(config.managementWorktree)) throw new Error("management worktree is missing");
    const branch = git(config.managementWorktree, ["branch", "--show-current"]);
    if (branch !== config.managementBranch) throw new Error(`management branch mismatch: ${branch || "detached"}`);
    const currentDocumentHashes = documentHashes(config.managementWorktree);
    if (!sameDocumentHashes(currentDocumentHashes, expectedDocumentHashes)) {
      throw new Error("management document hashes do not match expected results");
    }
    const existingIntent = ackIntentRecord(root);
    if (existingIntent.exists) {
      if (!existingIntent.intent) throw new Error("ACK intent is invalid; manual inspection required");
      if (!ackIntentMatchesRequest(existingIntent.intent, owner, eventIds, expectedDocumentHashes)) {
        throw new Error("ACK intent does not match lock owner, event IDs, or document hashes");
      }
      const recoveryReasons = ackIntentRecoveryReasons(root, config, persistedState, existingIntent.intent, owner);
      if (recoveryReasons.length) throw new Error(`ACK intent recovery is unsafe: ${recoveryReasons.join("; ")}`);
    } else if (!sameDocumentHashes(owner.baselineHashes, state.documentHashes)) {
      throw new Error("document baseline changed after lock acquisition");
    }
    const allPendingEvents = readPendingEvents(root);
    const requestedIds = new Set(eventIds);
    const transactionPendingEvents = existingIntent.exists
      ? allPendingEvents.filter((event) => requestedIds.has(event.eventId))
      : allPendingEvents;
    const conflicts = activeClaimConflicts(state, transactionPendingEvents);
    if (conflicts.length) throw new Error(`active claim conflicts block ACK: ${JSON.stringify(conflicts)}`);
    if (!existingIntent.exists && recoveryEvents.some((event) => !requestedIds.has(event.eventId))) {
      throw new Error("event IDs must include all recovery events");
    }
    const requestedEvents = [];
    const pendingEvents = [];
    for (const eventId of eventIds) {
      const source = path.join(root, "events", "pending", `${eventId}.json`);
      const destination = path.join(root, "events", "processed", `${eventId}.json`);
      if (!existsSync(source) && !existsSync(destination)) throw new Error(`event not found: ${eventId}`);
      const event = readJson(existsSync(source) ? source : destination);
      if (!isStoredEvent(event, eventId)) throw new Error(`invalid stored event: ${eventId}`);
      requestedEvents.push(event);
      if (!state.processedEventIds.includes(eventId)) pendingEvents.push(event);
    }
    if (!existingIntent.exists) {
      const selectedTaskIds = new Set(requestedEvents.map((event) => event.taskId));
      for (const event of allPendingEvents) {
        if (selectedTaskIds.has(event.taskId) && !requestedIds.has(event.eventId)) {
          throw new Error(`event IDs must include all pending events for selected task: ${event.taskId}`);
        }
      }
    }
    const currentBlocks = currentProjectionBlocks(config.managementWorktree);
    for (const event of latestEventsByTask(requestedEvents)) {
      const taskBlocks = currentBlocks.filter((block) => block.taskId === event.taskId);
      if (taskBlocks.length !== 1) {
        throw new Error(`event is not canonically projected; selected task must have exactly one current projection: ${event.taskId}`);
      }
      const expected = projectionBlock(event);
      if (taskBlocks[0].taskLine !== expected.taskLine || taskBlocks[0].projectionLine !== expected.projectionLine) {
        throw new Error(`event is not canonically projected in STATUS.md or BACKLOG.md: ${event.eventId}`);
      }
    }
    requireToken(root, token);
    const ackIntent = ensureAckIntent(root, owner, eventIds, expectedDocumentHashes);
    terminateTestProcess(_testTerminateAfterPhase, _testTerminationSignal, "intent");
    if (_testCrashAfterPhase === "intent") throw new Error("simulated crash after ACK intent");
    requireToken(root, token);
    for (const event of sortEventsByCreation(pendingEvents)) {
      const source = path.join(root, "events", "pending", `${event.eventId}.json`);
      const destination = path.join(root, "events", "processed", `${event.eventId}.json`);
      if (existsSync(source)) renameSync(source, destination);
    }
    terminateTestProcess(_testTerminateAfterPhase, _testTerminationSignal, "events");
    if (_testCrashAfterPhase === "events") throw new Error("simulated crash after ACK event moves");
    const reconciledState = reconcileProcessedState(root, state).state;
    reconciledState.documentHashes = currentDocumentHashes;
    reconciledState.lastSynchronizedAt = new Date().toISOString();
    _testBeforeStateWrite?.();
    requireToken(root, token);
    writeJsonAtomic(stateFile, reconciledState);
    if (_testCrashAfterPhase === "state") throw new Error("simulated crash after ACK state");
    removeOwnedLockUnderLifecycle(root, token);
    terminateTestProcess(_testTerminateAfterPhase, _testTerminationSignal, "owner");
    completeAckCleanup(root, config, reconciledState, ackIntent, { allowedLiveMarker: marker });
    if (_testCrashAfterPhase === "journal") throw new Error("simulated crash after ACK journal cleanup");
    return reconciledState;
  } finally {
    removeLifecycleIntent(marker);
  }
}

export function adoptDocuments({ cwd, token, _testAfterLifecycleAcquired, _testBeforeStateWrite }) {
  const root = stateRoot(cwd);
  const marker = createLifecycleIntent(root, "adopt", { lockToken: token });
  try {
    assertExclusiveLifecycleIntent(root, marker);
    _testAfterLifecycleAcquired?.();
    requireToken(root, token);
    if (existsSync(path.join(root, ACK_INTENT_FILE))) {
      throw new Error("ACK intent must be completed before adopting documents");
    }
    const config = readJson(path.join(root, "config.json"));
    if (!existsSync(config.managementWorktree)) throw new Error("management worktree is missing");
    requireToken(root, token);
    const branch = git(config.managementWorktree, ["branch", "--show-current"]);
    if (branch !== config.managementBranch) throw new Error(`management branch mismatch: ${branch || "detached"}`);
    const stateFile = path.join(root, "state.json");
    const state = readJson(stateFile);
    requireToken(root, token);
    state.documentHashes = documentHashes(config.managementWorktree);
    _testBeforeStateWrite?.();
    requireToken(root, token);
    writeJsonAtomic(stateFile, state);
    removeOwnedLockUnderLifecycle(root, token);
    return state;
  } finally {
    removeLifecycleIntent(marker);
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
}

function readExpectedDocumentHashes(cwd, file) {
  const root = realpathSync(cwd);
  const candidate = path.resolve(cwd, file);
  if (path.extname(candidate) !== ".json") {
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
  if (command === "recover-ack-cleanup") {
    return { recovered: recoverAckCleanup({ cwd, confirm: args.includes("--confirm") }) };
  }
  if (command === "project") {
    return renderEventProjections({
      cwd,
      token: valueAfter(args, "--token"),
      eventIds: valueAfter(args, "--event-ids").split(",").filter(Boolean),
    });
  }
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
