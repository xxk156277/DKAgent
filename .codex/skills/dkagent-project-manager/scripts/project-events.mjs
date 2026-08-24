#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
  if (SHELL_CONSTRUCT.test(command) || SENSITIVE_HEADER.test(command) || SENSITIVE_FLAG.test(command) || URL_USERINFO.test(command)) {
    return true;
  }
  const tokens = command.trim().split(/\s+/);
  return tokens.some((token) => ENVIRONMENT_ASSIGNMENT_TOKEN.test(token)) || !isAllowedValidationCommand(tokens);
}

function validateStoredText(value, field, maximumLength, { singleLine = false, command = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > maximumLength) throw new Error(`${field} text is too long`);
  if (singleLine && /[\r\n]/.test(value)) throw new Error(`${field} must be a single line`);
  if (
    SECRET_ASSIGNMENT.test(value)
    || BEARER_TOKEN.test(value)
    || SK_TOKEN.test(value)
    || (command && isUnsafeSimpleCommand(value))
  ) {
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

export function readSnapshot({ cwd }) {
  const root = stateRoot(cwd);
  const pending = path.join(root, "events", "pending");
  const events = readdirSync(pending)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(pending, name)));
  return {
    config: readJson(path.join(root, "config.json")),
    state: readJson(path.join(root, "state.json")),
    events,
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
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
  if (command === "snapshot") return readSnapshot({ cwd });
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
