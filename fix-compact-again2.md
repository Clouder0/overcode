# Fix Compact Again (v2)

Goal: remove remaining correctness + concurrency hazards around compaction/summarize/revert, harden CPD/markers, and fix related TUI reliability issues.

This document is the source of truth for progress (check items as they land).

Current status (2026-01-29): All checklist items complete; `bun run typecheck` and `bun test` pass in `packages/opencode`.

## Scope

Server/session-core:
- Part-level revert cleanup deletes the wrong message.
- Manual `POST /session/:id/summarize` can overlap prompt loop (delivered wake + direct prompt + abort idle gap).
- `SessionPrompt.assertNotBusy` ignores manual compaction.
- Message deletion leaves orphan parts on disk.
- `SessionCPD.set` monotonic check is non-atomic under concurrency.
- Compaction marker TTL should tolerate malformed records.
- Manual compaction ACTIVE_TTL should not abort on read.
- `/session/:id/context` token estimate should not throw.

TUI:
- Async session sync effect can toast/navigate for the wrong session (no cancellation).
- CPD "Context updated" toast fires on session switch.
- `initialPrompt` only applies once across session changes.
- DialogContext can spin forever on API errors.
- Sync cache not reset on server restart.
- Subagent session viewing mutates global model/variant.
- Windows paste image intercept calls `preventDefault()` too late.

## Plan

### 1) Tests first (lock in bugs)

- [x] Add unit test for part-level revert: boundary message preserved, tail parts removed, later messages removed.
- [x] Add integration test: `/summarize` early-window race (delivered message before manual lock/busy) must not start prompt loop.
- [x] Add integration test: `/abort` during in-flight manual summarize must not create an idle gap that allows prompt loop to start.

### 2) Fix part-level revert + deletion hygiene

- [x] Fix `SessionRevert.cleanup` boundary logic for `partID` (preserve boundary message when trimming parts).
- [x] Delete parts when deleting messages during revert cleanup.
- [x] Delete parts when deleting a message via `Session.removeMessage`.

### 3) Make manual summarize mutually exclusive with prompt loop

- [x] Acquire manual compaction lock + set `SessionStatus=busy` earlier in `/summarize` (fail fast and close the race window).
- [x] Prevent `SessionPrompt.loop` from starting when manual compaction is active.
- [x] Update delivered-message wake path to suppress waking even when status is `idle` if manual compaction is active.
- [x] Fix `/abort` ordering/behavior: do not flip status to `idle` via `SessionPrompt.cancel` while manual compaction is active.
- [x] Expand `SessionPrompt.assertNotBusy` to treat manual compaction as busy.

### 4) CPD + marker robustness

- [x] Make `SessionCPD.set` atomic via `Storage.update` (preserve monotonic `upto`).
- [x] Harden `SessionCompaction.marker` to treat invalid/missing `time.created` as stale and clear it.
- [x] Remove abort-on-read behavior from manual ACTIVE_TTL path (or make it lock-only, not aborting).
- [x] Make `/session/:id/context` estimate stringify safe (mirror prompt.ts try/catch).

### 5) TUI reliability fixes

- [x] Add cancellation guard to async session sync effect (avoid stale toasts/navigation).
- [x] Key contextState by sessionID (no CPD toast on session switch).
- [x] Reset `initialPromptApplied` on session change.
- [x] Fix DialogContext resource to throw on API error (show error, not infinite loading).
- [x] Clear full-sync caches on `server.instance.disposed`.
- [x] Prevent subagent session view from mutating global model/variant.
- [x] Fix Windows image paste intercept: prevent default synchronously and re-insert text when not image.

### 6) Verification

- [x] `bun run typecheck` (repo or package-level)
- [x] `bun test` (packages/opencode)

## Progress log

- Started: 2026-01-29

- 2026-01-29: Added new unit/integration coverage (revert + summarize concurrency)
- 2026-01-29: Fixed part-level revert cleanup boundary logic
- 2026-01-29: Fixed message deletion hygiene (delete orphan parts)
- 2026-01-29: Made manual summarize mutually exclusive with prompt loop
- 2026-01-29: Made SessionCPD monotonic updates atomic
- 2026-01-29: Hardened compaction marker TTL handling
- 2026-01-29: Made `/session/:id/context` token estimate stringify-safe
- 2026-01-29: TUI: added cancellation + fixed CPD toast on session switch
- 2026-01-29: TUI: fixed Windows paste image intercept
- 2026-01-29: Fixed `/abort` to keep `SessionStatus=busy` while manual summarize remains in-flight
- 2026-01-29: TUI: reset initial prompt on session switch; fixed context dialog error state; cleared sync caches on server restart; avoid subagent session model/variant pollution
- 2026-01-29: Regenerated JavaScript SDK
- 2026-01-29: Verified `bun run typecheck` + `bun test` in `packages/opencode`
