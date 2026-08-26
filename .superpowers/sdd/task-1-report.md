# Task 1 Report

## Status

Completed. Implemented the Trace selector and deterministic M1 assertion core.

## TDD evidence

- RED: `pnpm exec tsx --test evals/agent-loop/*.test.ts` failed with `ERR_MODULE_NOT_FOUND` for the intentionally absent `evals/agent-loop/assertions.js` module.
- GREEN: `pnpm run test:agent-eval` passed all 3 tests (3 pass, 0 fail).
- GREEN types: `pnpm run typecheck:agent-eval` exited 0.
- Formatting: `git diff --check` exited 0 with no output.

## Changes

- Added `selectToolCalls`, `selectToolResults`, `findUnpairedToolCallIds`, and `hasNormalTermination` over existing `TraceEvent[]` values.
- Added deterministic `gradeAgentRun` components for run errors, required Tool presence, successful required results, pairing, output marker, and normal termination.
- Added the requested eval TypeScript config and root scripts.
- Added exact `promptfoo@0.121.19`; added root `@dkagent/trace@workspace:*` devDependency so the exact requested eval tsconfig resolves the workspace import during typecheck.

## Concerns

- `pnpm add` refreshed the lockfile's transitive dependency graph because Promptfoo has a large dependency tree; no unrelated source files were changed.
- The known baseline monorepo layout test was not run or changed; this task's focused checks are green.
