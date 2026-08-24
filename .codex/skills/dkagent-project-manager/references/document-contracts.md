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

STATUS/BACKLOG hold one current projection per `taskId`: the current projection is always the latest event. When a later event arrives, replace the previous two-line block rather than displaying both `in_progress` and the later status. Every processed event JSON remains unchanged under `events/processed/` as the complete audit history.

`project` and ACK sort requested events by `(createdAt,eventId)` and fold them by `taskId`; only the folded latest projection is written and verified, while every requested event is still moved to `events/processed/` and recorded in that order. `eventIds` must include all pending events for each selected task, so a partial ACK cannot later overwrite the current view with an older event. A requested event already moved to processed during the recovery window but not yet recorded in state remains eligible for ACK.

The processed directory is the source of truth for derived state. Snapshot scans every valid stored event in `(createdAt,eventId)` order and returns a read-only reconciled `state` plus `recoveryEvents` for processed events absent from persisted `processedEventIds`; snapshot never writes state. Conflicts use the reconciled active claims plus all pending events, so a restart cannot hide WIP.

ACK requires all recoveryEvents IDs in `eventIds`; they participate in the same task-folded projection validation with pending events instead of being silently recorded. Before publishing a new journal, ACK reconciles processed state and checks WIP conflicts against all pending events. On success it scans processed again and persists complete sorted `processedEventIds` and replayed `activeClaims`, including recovered events. On failure it writes neither state nor event moves and retains the lock.

ACK scans canonical projection blocks in both documents. Each selected task must have exactly one current block across STATUS and BACKLOG, and that block must equal the folded latest event. It rejects only-old projection, old+new coexistence, repeated blocks in one file, and duplicates split across both files.

## Two-phase ACK journal

After basic canonical UUID, uniqueness, and document-hash shape validation, ACK atomically publishes its complete unique lifecycle marker before reading owner, current hashes, or state. The strict ACK marker binds `lockToken`, sorted unique `eventIds`, and exact `expectedDocumentHashes`; adopt binds `lockToken`, while release and recover use their smaller strict schemas. Acquire checks markers both before and after publishing an owner. The ACK lifecycle marker remains held through journal validation/publication, event moves, state persistence, and owner deletion; terminal cleanup then removes exact markers before deleting the still-durable journal last. Adopt, release, recover, and acquire cannot proceed during the lifecycle, and the journal continues blocking acquire through cleanup. ACK removes its owned lock inside the same lifecycle instead of starting a nested release operation, and revalidates the owner token before journal publication, event moves, and state write. Competing operations may both stop, but cannot both continue.

The owner PID describes a durable Agent lease and is never evidence that ownership ended. The short-lived lifecycle PID may be checked only for a dead matching ACK marker. Exact eligibility requires a strict marker whose `lockToken`, sorted IDs, and expected hashes match the retry and current owner; any ACK journal must also match the same owner identity, IDs, and hashes. The dead ACK marker is left in place while the current live retry marker provides exclusivity. A second contender sees that live marker and stops, or simultaneous contenders both stop; they cannot both write. Live or EPERM, malformed, different-token, different-ID/hash, different-operation, and journal-mismatched markers hard-block.

Before state commit, any branch, owner, hash, WIP, projection, event-set, or journal validation failure removes only the current marker and leaves the dead marker unchanged. Release, recover, and adopt continue to treat that marker as blocking, so lost request parameters require manual inspection rather than lease teardown.

For a crash before journal publication, takeover is still limited to an exact retry using the retained original token, `eventIds`, and expected hashes. Because no journal can reconstruct those request facts, lost original parameters require a manual stop with the owner and marker intact; re-render, adopt, release, and ordinary recovery are forbidden.

After every hash, branch, WIP, event-set, and projection check succeeds but before moving an event, ACK exclusively publishes common-root `ack-intent.json`. Its fixed schema contains only `schemaVersion`, `lockOwner` (`token`, `pid`, `acquiredAt`), sorted `eventIds`, `expectedDocumentHashes`, `baselineHashes`, and `createdAt`; commands, logs, secrets, and extra fields are forbidden. An existing journal permits only the same token, owner identity, eventIds, and hashes. Any invalid or different journal hard-blocks without overwrite.

Journal freezes transaction facts to its exact `eventIds` and `expectedDocumentHashes`. New journal creation still checks all pending events for WIP and selected-task completeness. During exact recovery of an existing journal, pending events emitted afterward do not join its WIP or completeness checks and cannot be added to the retry; they remain pending for the next snapshot, projection, and ACK.

The commit order is intent → move events → write reconciled state → delete owner → clean exact ACK markers → delete journal last. A retry with the exact recorded inputs is idempotent before moves, after partial/all moves, and after state persistence. The journal remains the committed-cleanup durable fact throughout terminal cleanup, so acquire stays blocked until owner and markers are gone. Ordinary `release-lock` is blocked while the journal exists, and `recover-lock` still cannot remove a valid owner.

For an ownerless terminal journal, snapshot and lock-status return `recoveryMode: "ack_cleanup"` only when branch and document hashes equal the intent, persisted state hashes and processed IDs are committed, every processed file is legal, no intent ID remains pending, current projections are exact, and all related ACK markers match the journal and are dead. This mode runs only `recover-ack-cleanup --confirm`; ordinary ACK, lock recovery, adoption, release, and acquisition are forbidden.

Cleanup atomically renames each exact marker to a transaction-checked cleanup tombstone and deletes it. A crash at any rename/delete boundary retains the journal; a retry validates and removes remaining markers or tombstones before unlinking the journal. Live/EPERM, malformed, or different-transaction markers and any terminal fact drift hard-block cleanup without consuming the journal.

Snapshot exposes `ackIntentExists`, a valid `ackIntent` when safe to parse, and `ackRecoveryEventIds`. It returns `target.recoveryMode: "ack_intent"` only when the current lock owner identity matches, the management branch is correct, current document hashes equal intent expected hashes, intent baseline equals the lock baseline, and persisted state is either still at that baseline or already committed to expected hashes with every intent event recorded. A second document drift, owner/token change, invalid journal, or unrelated state phase remains `target.safe:false`; it is never adopted as normal progress.

`lock-status` exposes parsed `lifecycleIntents` with validity, operation, lock token, PID liveness, and `takeoverEligible`, so the exact ACK recovery path is observable without treating the owner PID as a lease timeout.

## Document adoption

`adopt-documents` publishes an `operation: adopt` lifecycle marker bound to the owner `lockToken` before reading owner state. It confirms exclusivity, rejects an existing ACK intent, revalidates the owner token before management-branch inspection, document hash read, and state write, then removes the owner inside the same marker. ACK and adopt cannot both write; neither calls public `release-lock` while holding its marker.

## BACKLOG.md

Columns: `ID | Priority | Module | Status | Dependencies | Ordering reason | Source | Updated`. Status is `ready|in_progress|needs_verification|blocked|completed`. V1 never deletes or archives automatically.

The eight-column BACKLOG row remains the human priority view but does not satisfy ACK by itself. Store the exact folded helper-generated current block in STATUS or BACKLOG, replacing the prior block when the same task advances.

## Conflicts

Snapshot conflicts are a stable discriminated union:

```json
{"kind":"task_claimed_by_multiple_worktrees","taskId":"DKA-...","worktrees":["/canonical/a","/canonical/b"]}
{"kind":"worktree_claims_multiple_tasks","worktreePath":"/canonical/a","taskIds":["DKA-AAA","DKA-BBB"]}
```

Arrays and conflict groups are sorted. Any snapshot conflict stops document edits. Before a new journal is published, ACK independently recomputes both conflict kinds from current processed state plus every pending event; any conflict preserves the lock and all events. Recovery of an already published journal uses only its frozen event set, leaving later pending events for the next transaction.

## Priority

User order first; P0 is multi-task blocker/security/data/release risk; P1 is current critical path or dependency unblocker; P2 is next independently deliverable value; P3 is candidate or later work. Within a priority, unblock dependencies before comparing risk and value. Record reorder reasons and ask before deletion, postponement, or goal changes.

## Evidence

Code work needs behavior-relevant verification. `test` only accepts a test command, `typecheck` only a type-check command, and `build` only a build command. `git diff --check`, `node --check`, Skill validation, and commit provenance cannot be labeled as behavior tests. Typecheck proves types; focused tests prove covered behavior; Fake Provider tests do not prove a real API. Commit SHA alone never proves behavior. Pure documentation/rule work may use explicit acceptance.

If a Worker submits `finished/completed` without successful behavior evidence or user confirmation, including failed execution evidence or commit-only provenance, `emit` preserves `finished` and deterministically downgrades it to `needs_verification`.

## Lock recovery

Use `lock-status` first. A valid owner is a durable Agent lease even when its CLI PID has exited, and `recover-lock` never removes it. If the local token was lost, retrieve `owner.token` from status and release it only when the remaining owner facts match the current aggregation; otherwise stop for human confirmation. Confirmed recovery is limited to invalid/legacy ownerless locks and stale creating files when no lifecycle marker exists. `recover-lock` never removes lifecycle markers; only an exact ACK retry may proceed beside its eligible dead matching marker, which remains authoritative until successful cleanup. All other markers and any owned recovery tombstone hard-block recovery. After valid ownerless recovery, check status and acquire a new token.
