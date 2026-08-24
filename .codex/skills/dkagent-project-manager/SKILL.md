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

WIP=1 applies per Agent/worktree. An active worktree cannot claim a second task.

## Initialization

Run `git worktree list --porcelain`. If state is absent, choose the single worktree on `refs/heads/main`, then run the resolved helper with `init --management-worktree <absolute-main-worktree> --management-branch main`. If there is no unique main worktree, ask the user; never choose a detached or feature worktree silently.

## Worker event

Create a temporary JSON file using the strict reference shape. Reuse a BACKLOG ID; for unplanned work use `DKA-YYYYMMDD-<short-random-id>`. Never include secrets or raw logs. Run the resolved helper with `emit --file <absolute-json-path>`, then delete only that input file.

For code work, `completed` needs successful behavior-relevant test, typecheck, build, or explicit acceptance. A commit SHA is provenance only. Failed or skipped verification becomes `needs_verification`.

## Aggregation

1. Run the resolved helper with `acquire-lock` and retain the token.
2. Run it with `snapshot --token <token>`.
3. If `target.safe` is false, edit nothing; release the lock and report the reason.
4. Duplicate active claims become P0 conflicts; do not choose a winner.
5. Patch only the three management documents in `target.managementWorktree`.
6. 从 `snapshot` 的 `target.managementWorktree` 读取已渲染的三份文档并计算精确 SHA-256（文件不存在时为 `null`）：`AGENTS.md`、`docs/project/STATUS.md`、`docs/project/BACKLOG.md`；不得从 worker checkout 计算 hash。把这三个值写入调用 CLI 的当前 worktree 内的临时 JSON，然后运行 `ack --token <token> --event-ids <comma-separated-ids> --expected-hashes-file <absolute-json-path>`，最后只删除该临时 hashes 文件。ACK 必须使用渲染后的 hashes，否则会被拒绝且事件保持 pending。
7. Report facts, downgraded statuses, priority changes, and unresolved conflicts.

After a failed patch, run `release-lock`. Lock contention leaves events pending and is reported as `待汇总`, not as a development failure.

## External document edits

When hashes differ, stop and show the diff. Only after explicit approval run `adopt-documents --token <token>`, acquire a new lock, and aggregate again.

## Authority

You may add and reprioritize evidence-backed items with reasons. Ask before deletion, postponement, or goal changes. Never commit, merge, push, create/delete worktrees, modify business code, or edit design/OpenSpec documents unless separately requested.
