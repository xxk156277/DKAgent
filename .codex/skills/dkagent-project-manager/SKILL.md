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
- A valid owner is an Agent lease even after the short-lived CLI process exits. The owner PID is never used to declare the lease dead, and `recover-lock` must never remove it.
- If this aggregation loses its local token, run `lock-status`, inspect `owner`, and retrieve `owner.token`. Use `release-lock --token <owner.token>` only when owner facts (`acquiredAt`, baseline hashes, and current aggregation context) identify the same lease. If facts conflict or identity is uncertain, stop for human confirmation.
- An unfinished ACK intent preserves that owner: `release-lock` and new lock acquisition are blocked until the exact ACK recovery completes. Never delete the journal or replace its owner manually.
- `lock-status` exposes each marker under `lifecycleIntents`, including schema validity, operation, `lockToken`, sorted `eventIds`, `expectedDocumentHashes`, `processAlive`, and `takeoverEligible`. Every ACK marker binds its owner token, sorted canonical eventIds, and expected hashes before owner/hash/state reads. A dead matching ACK marker permits only a retry with that exact request. The old marker remains intact while the retry's new live marker excludes contenders; only a successful ACK removes the dead marker after state and owner commit while the journal remains durable. Wrong eventIds or hashes, live/EPERM, malformed, different-token, different-operation, or journal-mismatched markers are hard stops and leave the recovery marker intact.
- Use `recover-lock --confirm` only for an invalid/legacy ownerless lock or stale creating file when no lifecycle marker exists. `recover-lock` never deletes any lifecycle marker or valid owner; matching dead ACK takeover belongs only to `ack`.
- After valid recovery, re-run `lock-status`, then acquire a new token; never reuse an old token.

## Aggregation

1. Follow the lock lifecycle above and retain the acquired token.
2. Run `snapshot --token <token>`. The processed event directory is the source of truth: snapshot returns a read-only reconciled `state` plus sorted `recoveryEvents` for processed files missing from persisted state, without writing state. Include every `recoveryEvents[].eventId` in `event-ids`; never acknowledge other work while omitting recovery events.
3. If `target.recoveryMode` is `ack_cleanup`, confirm `lock-status.recoveryMode` matches, then run `recover-ack-cleanup --confirm`. This ownerless committed mode revalidates branch, documents, projections, pending absence, and every related dead marker. It also requires every processed directory entry to be a canonical UUID JSON regular file with a valid matching stored event, then derives canonical `processedEventIds` and `activeClaims` from the complete history and requires persisted state to match exactly. In `ack_cleanup`, do not run ordinary ACK, `recover-lock`, release, adopt, acquire, or edit documents. A failed cleanup leaves the journal for inspection and exact retry.
4. If there is no ACK journal but `lock-status` reports a dead matching ACK marker as `takeoverEligible: true`, this is a crash before journal publication, not ordinary drift. Without an ACK journal, retry only with the retained original token, exact `eventIds`, and exact expected hashes; do not re-render, adopt, release, recover, or change the request. If the original ACK parameters are lost, manual stop is required with the owner and marker intact; the marker continues to block `release-lock`.
5. If `target.recoveryMode` is `ack_intent`, run `lock-status` and recover the matching `owner.token`. If a lifecycle marker remains, continue only when its entry is `operation: ack`, has the same `lockToken`, exact sorted IDs and hashes, is explicitly dead, and reports `takeoverEligible: true`. Copy `ackIntent.expectedDocumentHashes` into the temporary hashes JSON, then retry ACK with exactly `ackRecoveryEventIds`. An existing ACK journal freezes its IDs and hashes: later pending events are excluded from this retry and remain for the next aggregation. Do not re-render or adopt documents, add IDs, change hashes, release the owner, run `recover-lock`, or acquire another lock. If the exact retry fails, stop with the journal, marker, and owner intact.
6. If `target.safe` is true with no ACK intent, pending `events`, or `recoveryEvents`, no aggregation remains; release the retained owner token.
7. If `target.safe` is false and `ackIntentExists` is false, this is ordinary drift only after step 4 has ruled out a recoverable pre-journal ACK marker: edit nothing, run `release-lock --token <token>`, and report the reason. If `ackIntentExists` is true but recovery mode is absent, facts conflict; do not release or recover the owner, and stop for manual inspection.
8. If snapshot 的 `conflicts` 非空, stop for either conflict kind, edit nothing, release the lock, and report the stable conflict object. Never choose a winner.
9. Include all recovery events and all pending events for every selected task in `event-ids`, then run `project --token <token> --event-ids <comma-separated-ids>`. The helper sorts by `createdAt` then `eventId`, folds by taskId, and returns one latest `block` per task. Copy each block verbatim into either STATUS or BACKLOG in `target.managementWorktree`. The block binds every stored event fact, including schema version, canonical worktree, branch, HEAD, and creation time; never hand-write, reserialize, abbreviate, or split it. Replace that task's previous block with the latest block and ensure the task appears exactly once across both documents—never retain old+new, same-file duplicates, or cross-file duplicates. Processed event JSON remains the complete audit history. Patch other human-readable sections only as needed.
10. 从 `snapshot` 的 `target.managementWorktree` 读取已渲染的三份文档并计算精确 SHA-256（文件不存在时为 `null`）：`AGENTS.md`、`docs/project/STATUS.md`、`docs/project/BACKLOG.md`；不得从 worker checkout 计算 hash。把这三个值写入调用 CLI 的当前 worktree 内的临时 JSON，然后运行 `ack --token <token> --event-ids <comma-separated-ids> --expected-hashes-file <absolute-json-path>`，最后只删除该临时 hashes 文件。首次 ACK 在发布 journal 前先从 processed 协调 state，再与全部 pending 检查双向 WIP 冲突；它拒绝遗漏 recovery event、selected task 的部分 pending 集合，以及不唯一或不精确的 folded latest projection。ACK 从入口创建独占 marker，阻止 acquire/release/recover；journal、event move、state write 前都重验 token。提交尾段固定为 write state → delete owner → atomically clean exact markers → delete journal last。journal 在 terminal cleanup 全程继续阻止 acquire；任一失败都保留可恢复事实。
11. Report facts, downgraded statuses, priority changes, and unresolved conflicts.

After a failed document patch, run `release-lock` only when no ACK journal or lifecycle marker exists. Lock contention leaves events pending and is reported as `待汇总`, not as a development failure.

## External document edits

When hashes differ, stop and show the diff. Only after explicit approval run `adopt-documents --token <token>`. Adopt publishes an `operation: adopt` lifecycle marker bound to the lock token, rejects any ACK intent, revalidates the owner before branch/hash/state writes, persists hashes, and deletes the owner inside the same lifecycle. Then acquire a new lock and aggregate again.

## Authority

You may add and reprioritize evidence-backed items with reasons. Ask before deletion, postponement, or goal changes. Never commit, merge, push, create/delete worktrees, modify business code, or edit design/OpenSpec documents unless separately requested.
