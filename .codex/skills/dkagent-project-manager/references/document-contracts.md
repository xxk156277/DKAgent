# Project document contracts

Read this reference for Worker event creation or document aggregation.

## Event input

Allowed keys are `taskId`, `action`, `module`, `summary`, `status`, `dependencies`, `evidence`, and `discoveredTodos`.

`action`: `started|finished|blocked|discovered`. `status`: `in_progress|completed|needs_verification|blocked`.

Evidence uses `{ "kind": "test|typecheck|build|commit|user_confirmation", "summary": "...", "command": "...", "exitCode": 0 }`. Omit command/exitCode only for provenance or explicit confirmation. Never store raw logs, credentials, environment variables, or inferred outcomes.

Discovered todos use `{ "summary": "...", "module": "...", "reason": "..." }`.

All persisted free text (`taskId`, module, summary, dependency, evidence summary, and every discovered-todo field) must be non-empty, single-line text and must not start a Markdown heading. CR/LF and heading injection are rejected.

`taskId` and every dependency use canonical uppercase format `^DKA-[A-Z0-9][A-Z0-9-]{2,63}$`. Leading/trailing whitespace, lowercase, invalid characters, and noncanonical length are rejected; inputs are never silently normalized.

## STATUS.md

Sections: `当前里程碑`、`活跃 Worktree`、`待验证`、`阻塞与风险`、`最近完成`、`最后同步`. Worktree presence alone is not an active task. Do not report percentages without a verifiable denominator.

Every event selected for ACK must have one complete two-line projection block in either STATUS or BACKLOG. Generate it only with `project --token <token> --event-ids <ids>` and copy the returned `block` verbatim:

```text
- [project-task] {"taskId":"DKA-EXAMPLE","status":"in_progress","module":"agent","summary":"Implement example","worktreePath":"/canonical/repo","branch":"feature/example","headSha":"<40-hex-head>","createdAt":"<iso-time>"}
- [project-event] {"digest":"<sha256>","payload":{"schemaVersion":1,"eventId":"<uuid>","taskId":"DKA-EXAMPLE","action":"started","status":"in_progress","module":"agent","summary":"Implement example","dependencies":[],"evidence":[],"discoveredTodos":[],"worktreePath":"/canonical/repo","branch":"feature/example","headSha":"<40-hex-head>","createdAt":"<iso-time>"}}
```

The human line must exactly match event `taskId`, `status`, `module`, `summary`, `worktreePath`, `branch`, `headSha`, and `createdAt`. The canonical payload field order is `schemaVersion`, `eventId`, `taskId`, `action`, `status`, `module`, `summary`, `dependencies`, `evidence`, `discoveredTodos`, `worktreePath`, `branch`, `headSha`, `createdAt`; evidence canonicalizes `kind`, `summary`, optional `command`, optional `exitCode`, and todos canonicalize `summary`, `module`, `reason`. `digest` is SHA-256 of the compact canonical payload JSON and therefore binds the complete stored event. Missing source fields, an old or forged HEAD, HTML comments, prose, headings, stale status, recomputed partial payloads, and hand-written equivalents do not count.

STATUS/BACKLOG hold one current projection per `taskId`: the current projection is always the latest event. When a later event arrives, replace the previous two-line block rather than displaying both `in_progress` and the later status. The exact latest block is sufficient for its ACK; old blocks do not remain in the documents. Every processed event JSON remains unchanged under `events/processed/` as the complete audit history.

## BACKLOG.md

Columns: `ID | Priority | Module | Status | Dependencies | Ordering reason | Source | Updated`. Status is `ready|in_progress|needs_verification|blocked|completed`. V1 never deletes or archives automatically.

The eight-column BACKLOG row remains the human priority view but does not satisfy ACK by itself. Store the exact helper-generated current block in STATUS or BACKLOG, replacing the prior block when the same task advances.

## Conflicts

Snapshot conflicts are a stable discriminated union:

```json
{"kind":"task_claimed_by_multiple_worktrees","taskId":"DKA-...","worktrees":["/canonical/a","/canonical/b"]}
{"kind":"worktree_claims_multiple_tasks","worktreePath":"/canonical/a","taskIds":["DKA-AAA","DKA-BBB"]}
```

Arrays and conflict groups are sorted. Any snapshot conflict stops document edits. ACK independently recomputes both conflict kinds from current processed state plus every pending event immediately before moving files; any conflict preserves the lock and all events.

## Priority

User order first; P0 is multi-task blocker/security/data/release risk; P1 is current critical path or dependency unblocker; P2 is next independently deliverable value; P3 is candidate or later work. Within a priority, unblock dependencies before comparing risk and value. Record reorder reasons and ask before deletion, postponement, or goal changes.

## Evidence

Code work needs behavior-relevant verification. `test` only accepts a test command, `typecheck` only a type-check command, and `build` only a build command. `git diff --check`, `node --check`, Skill validation, and commit provenance cannot be labeled as behavior tests. Typecheck proves types; focused tests prove covered behavior; Fake Provider tests do not prove a real API. Commit SHA alone never proves behavior. Pure documentation/rule work may use explicit acceptance.

If a Worker submits `finished/completed` without successful behavior evidence or user confirmation, including failed execution evidence or commit-only provenance, `emit` preserves `finished` and deterministically downgrades it to `needs_verification`.

## Lock recovery

Use `lock-status` first. A valid owner is a durable Agent lease even when its CLI PID has exited, and `recover-lock` never removes it. If the local token was lost, retrieve `owner.token` from status and release it only when the remaining owner facts match the current aggregation; otherwise stop for human confirmation. Confirmed recovery is limited to invalid/legacy ownerless locks, stale creating files, and stale lifecycle intents. Live intents and owned recovery tombstones hard-block recovery. After recovery, check status and acquire a new token.
