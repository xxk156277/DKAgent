# Project document contracts

Read this reference for Worker event creation or document aggregation.

## Event input

Allowed keys are `taskId`, `action`, `module`, `summary`, `status`, `dependencies`, `evidence`, and `discoveredTodos`.

`action`: `started|finished|blocked|discovered`. `status`: `in_progress|completed|needs_verification|blocked`.

Evidence uses `{ "kind": "test|typecheck|build|commit|user_confirmation", "summary": "...", "command": "...", "exitCode": 0 }`. Omit command/exitCode only for provenance or explicit confirmation. Never store raw logs, credentials, environment variables, or inferred outcomes.

Discovered todos use `{ "summary": "...", "module": "...", "reason": "..." }`.

All persisted free text (`taskId`, module, summary, dependency, evidence summary, and every discovered-todo field) must be non-empty, single-line text and must not start a Markdown heading. CR/LF and heading injection are rejected.

## STATUS.md

Sections: `当前里程碑`、`活跃 Worktree`、`待验证`、`阻塞与风险`、`最近完成`、`最后同步`. Worktree presence alone is not an active task. Do not report percentages without a verifiable denominator.

Every event selected for ACK must have a visible structured task line in STATUS or a valid BACKLOG row. STATUS uses exactly one JSON object per Markdown list line:

```text
- [project-task] {"taskId":"DKA-...","status":"in_progress","title":"non-empty title","evidence":[]}
```

`status` uses the event status set, `title` is non-empty, and `evidence` is an array of concise evidence summaries. HTML comments, ordinary prose, headings, and malformed/empty-title markers do not count.

## BACKLOG.md

Columns: `ID | Priority | Module | Status | Dependencies | Ordering reason | Source | Updated`. Status is `ready|in_progress|needs_verification|blocked|completed`. V1 never deletes or archives automatically.

For ACK projection, a BACKLOG row must have all eight cells, a non-empty ID and module, priority `P0`-`P3`, and one allowed status. A task ID appearing elsewhere in the document does not count.

## Conflicts

Snapshot conflicts are a stable discriminated union:

```json
{"kind":"task_claimed_by_multiple_worktrees","taskId":"DKA-...","worktrees":["/canonical/a","/canonical/b"]}
{"kind":"worktree_claims_multiple_tasks","worktreePath":"/canonical/a","taskIds":["DKA-a","DKA-b"]}
```

Arrays and conflict groups are sorted. Any conflict stops aggregation before document edits or ACK.

## Priority

User order first; P0 is multi-task blocker/security/data/release risk; P1 is current critical path or dependency unblocker; P2 is next independently deliverable value; P3 is candidate or later work. Within a priority, unblock dependencies before comparing risk and value. Record reorder reasons and ask before deletion, postponement, or goal changes.

## Evidence

Code work needs behavior-relevant verification. `test` only accepts a test command, `typecheck` only a type-check command, and `build` only a build command. `git diff --check`, `node --check`, Skill validation, and commit provenance cannot be labeled as behavior tests. Typecheck proves types; focused tests prove covered behavior; Fake Provider tests do not prove a real API. Commit SHA alone never proves behavior. Pure documentation/rule work may use explicit acceptance.

If a Worker submits `finished/completed` without successful behavior evidence or user confirmation, including failed execution evidence or commit-only provenance, `emit` preserves `finished` and deterministically downgrades it to `needs_verification`.

## Lock recovery

Use `lock-status` first. Release a known owner token with `release-lock --token`; never recover it. `recover-lock --confirm` may remove an ownerless lock or a lock whose owner PID is explicitly dead. Live/`EPERM` PIDs, possible PID reuse, live lifecycle intents, and owned recovery tombstones hard-block recovery. After recovery, check status and acquire a new token.
