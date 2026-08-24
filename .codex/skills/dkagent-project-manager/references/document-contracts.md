# Project document contracts

Read this reference for Worker event creation or document aggregation.

## Event input

Allowed keys are `taskId`, `action`, `module`, `summary`, `status`, `dependencies`, `evidence`, and `discoveredTodos`.

`action`: `started|finished|blocked|discovered`. `status`: `in_progress|completed|needs_verification|blocked`.

Evidence uses `{ "kind": "test|typecheck|build|commit|user_confirmation", "summary": "...", "command": "...", "exitCode": 0 }`. Omit command/exitCode only for provenance or explicit confirmation. Never store raw logs, credentials, environment variables, or inferred outcomes.

Discovered todos use `{ "summary": "...", "module": "...", "reason": "..." }`.

## STATUS.md

Sections: `当前里程碑`、`活跃 Worktree`、`待验证`、`阻塞与风险`、`最近完成`、`最后同步`. Worktree presence alone is not an active task. Do not report percentages without a verifiable denominator.

## BACKLOG.md

Columns: `ID | Priority | Module | Status | Dependencies | Ordering reason | Source | Updated`. Status is `ready|in_progress|needs_verification|blocked|completed`. V1 never deletes or archives automatically.

## Priority

User order first; P0 is multi-task blocker/security/data/release risk; P1 is current critical path or dependency unblocker; P2 is next independently deliverable value; P3 is candidate or later work. Within a priority, unblock dependencies before comparing risk and value. Record reorder reasons and ask before deletion, postponement, or goal changes.

## Evidence

Code work needs behavior-relevant verification. Typecheck proves types; focused tests prove covered behavior; Fake Provider tests do not prove a real API. Commit SHA alone never proves behavior. Pure documentation/rule work may use explicit acceptance.
