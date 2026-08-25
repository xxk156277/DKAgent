## 1. SQLite Trace Store

- [x] 1.1 Add failing tests for schema creation, restart recovery, Session cascade, stale/equal revision, identity mutation, terminal regression, commit-before-notify, listener isolation and unsupported runtime spans.
- [x] 1.2 Implement the normalized `traces` and `trace_spans` schema, WAL/foreign-key setup, synchronous transactional upsert, bounded readers, defensive subscription and close behavior.
- [x] 1.3 Declare the `better-sqlite3` runtime dependency and verify Trace tests, Trace typecheck and `git diff --check`.

## 2. TraceDocument Reader

- [x] 2.1 Add failing tests for TraceSummary ordering/counts and complete TraceDocument reconstruction after database restart.
- [x] 2.2 Add failing tests for missingRoot, missingParent, running, outputMissing, serializationError, over-100 Span traces and unknown on-disk schema.
- [x] 2.3 Implement schemaVersion 2 TraceSummary/TraceDocument types, bounded document codec and explicit unsupported/corrupt-data errors.

## 3. Trace Query CLI

- [x] 3.1 Add CLI tests for bounded `recent`, text/JSON `show`, missing trace, invalid command/arguments and stdout JSON purity.
- [x] 3.2 Implement `npm run trace -- recent` and `npm run trace -- show <traceId> [--json]` without arbitrary SQL or write commands.

## 4. Runtime Composition

- [x] 4.1 Add Agent CLI tests proving ordinary runs create one shared SQLite-backed Tracer, injected resources are not double-closed and Trace failures remain passive.
- [x] 4.2 Migrate ordinary Agent to default SQLite Trace persistence while preserving Session, streaming, Memory, Artifact, Context and Interview behavior.
- [x] 4.3 Add Observe tests proving Tap and Agent share one SQLite Store/Tracer and Tap startup failure still persists Trace.
- [x] 4.4 Migrate Observe ownership and close order without implementing Web Tap V2 projection or APIs.

## 5. Verification

- [x] 5.1 Run full Trace and Agent tests/typechecks plus `git diff --check`; record the five known P2 Web V1 failures without expanding P1 scope.
- [x] 5.2 Run DKAgent against `test2.md`, stop the process, execute `recent` then `show <traceId> --json`, and verify root/parent/status/Token/duration consistency after restart.
- [x] 5.3 Scan persisted Trace bytes for configured credential values and confirm no Provider raw error message or secret is stored.
