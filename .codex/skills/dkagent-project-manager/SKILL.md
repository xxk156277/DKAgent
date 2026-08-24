---
name: dkagent-project-manager
description: Maintain verified DKAgent project status and backlog priorities across parallel Git worktrees. Use when starting or finishing a development task, synchronizing progress, reporting blockers, or arranging P0-P3 priorities; do not use for DKAgent runtime behavior or ordinary business-document editing.
---

# DKAgent Project Manager

Maintain project facts without turning plans or unverified code into completed work.

## Required context

Read root `AGENTS.md`, `docs/project/STATUS.md`, and `docs/project/BACKLOG.md`. For shapes, evidence rules, and priority order, read [references/document-contracts.md](references/document-contracts.md). Run `git rev-parse --show-toplevel`, then resolve the helper as `<returned-repo-root>/.codex/skills/dkagent-project-manager/scripts/project-events.mjs`; never resolve it from the current subdirectory or assume the current worktree is the management worktree.

## Modes

- `worker-start`: before coding, claim one task ID and emit `started`.
- `worker-finish`: after implementation and verification, emit `finished`, `blocked`, or `needs_verification`.
- `aggregate`: after every event or when progress/priorities are requested.

WIP=1 applies per Agent/worktree. An active worktree cannot claim a second task, and one task cannot be active in multiple worktrees.

## Initialization

Run `git worktree list --porcelain`. If state is absent, choose the single worktree on `refs/heads/main`, then run the resolved helper with `init --management-worktree <absolute-main-worktree> --management-branch main`. If there is no unique main worktree, ask the user; never choose a detached or feature worktree silently.

## Worker event

Create a temporary JSON file using the strict reference shape. Reuse a BACKLOG ID; for unplanned work use an uppercase canonical ID such as `DKA-YYYYMMDD-AB12`. Task IDs and dependencies must match `^DKA-[A-Z0-9][A-Z0-9-]{2,63}$` exactly; never trim or change case silently. Every persisted free-text field is one line and must not start a Markdown heading. Never include secrets or raw logs. Run the resolved helper with `emit --file <absolute-json-path>`, then delete only that input file.

For code work, `completed` needs successful behavior-relevant evidence or explicit acceptance. Evidence kind must match the command: `test` only runs tests, `typecheck` only runs type checking, and `build` only runs builds. `git diff --check`, `node --check`, Skill validation, and a commit SHA do not prove behavior. When a `finished/completed` event has no successful behavior evidence, or its execution evidence failed, `emit` preserves `action: finished` and deterministically changes status to `needs_verification`.

## Lock lifecycle

Before aggregation, run `lock-status`.

- If no lock or lifecycle marker is present, run `acquire-lock` and retain the complete owner result, especially its token.
- A valid owner is an Agent lease even after the short-lived CLI process exits. `recover-lock` must never remove it and PID liveness is not lease ownership.
- If this aggregation loses its local token, run `lock-status`, inspect `owner`, and retrieve `owner.token`. Use `release-lock --token <owner.token>` only when owner facts (`acquiredAt`, baseline hashes, and current aggregation context) identify the same lease. If facts conflict or identity is uncertain, stop for human confirmation.
- Use `recover-lock --confirm` only for an invalid/legacy ownerless lock, stale creating file, or stale lifecycle intent. A valid owner, live lifecycle intent, or any owned recovery tombstone is a hard stop.
- After valid recovery, re-run `lock-status`, then acquire a new token; never reuse an old token.

## Aggregation

1. Follow the lock lifecycle above and retain the acquired token.
2. Run `snapshot --token <token>`. The processed event directory is the source of truth: snapshot returns a read-only reconciled `state` plus sorted `recoveryEvents` for processed files missing from persisted state, without writing state. Include every `recoveryEvents[].eventId` in `event-ids`; never acknowledge other work while omitting recovery events.
3. If `target.safe` is false, edit nothing; run `release-lock --token <token>` and report the reason.
4. If snapshot 的 `conflicts` 非空, stop for either conflict kind, edit nothing, release the lock, and report the stable conflict object. Never choose a winner.
5. Include all recovery events and all pending events for every selected task in `event-ids`, then run `project --token <token> --event-ids <comma-separated-ids>`. The helper sorts by `createdAt` then `eventId`, folds by taskId, and returns one latest `block` per task. Copy each block verbatim into either STATUS or BACKLOG in `target.managementWorktree`. The block binds every stored event fact, including schema version, canonical worktree, branch, HEAD, and creation time; never hand-write, reserialize, abbreviate, or split it. Replace that task's previous block with the latest block and ensure the task appears exactly once across both documents—never retain old+new, same-file duplicates, or cross-file duplicates. Processed event JSON remains the complete audit history. Patch other human-readable sections only as needed.
6. 从 `snapshot` 的 `target.managementWorktree` 读取已渲染的三份文档并计算精确 SHA-256（文件不存在时为 `null`）：`AGENTS.md`、`docs/project/STATUS.md`、`docs/project/BACKLOG.md`；不得从 worker checkout 计算 hash。把这三个值写入调用 CLI 的当前 worktree 内的临时 JSON，然后运行 `ack --token <token> --event-ids <comma-separated-ids> --expected-hashes-file <absolute-json-path>`，最后只删除该临时 hashes 文件。ACK 先从 processed 协调 state，再与全部 pending 检查双向 WIP 冲突；它拒绝遗漏 recovery event、selected task 的部分 pending 集合，以及不唯一或不精确的 folded latest projection。成功后从 processed 全目录持久化 sorted IDs 与 active claims。任一失败都保留 lock 与事件。
7. Report facts, downgraded statuses, priority changes, and unresolved conflicts.

After a failed patch, run `release-lock`. Lock contention leaves events pending and is reported as `待汇总`, not as a development failure.

## External document edits

When hashes differ, stop and show the diff. Only after explicit approval run `adopt-documents --token <token>`, acquire a new lock, and aggregate again.

## Authority

You may add and reprioritize evidence-backed items with reasons. Ask before deletion, postponement, or goal changes. Never commit, merge, push, create/delete worktrees, modify business code, or edit design/OpenSpec documents unless separately requested.
