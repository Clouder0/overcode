# Fix Plan: Context Pipeline CPD + Tail

Goal: fix correctness/robustness issues in the new CPD + tail context pipeline.

Tracked issues

- [x] FIFO/turn-order bug: CPD delta selection uses message-id ordering and can drop assistant replies that occur before the target user in turn order.
- [x] Forced `context_length` maintenance can no-op when token estimates undercount (provider error persists across retries).
- [x] CPD delta file labels can inline huge `data:` URLs (base64 payload) and explode CPD update input.
- [x] Stray debug log in `GET /session/:sessionID`.

Plan

1) Safe file labels + shared formatting

- [x] Add `MessageV2.fileLabel(file)` (based on `SessionCompaction`'s proven logic) that never returns a raw `data:` payload and caps long URLs.
- [x] Use `MessageV2.fileLabel` in CPD delta builders:
  - `packages/opencode/src/session/prompt.ts`
  - `packages/opencode/src/server/routes/session.ts`

2) CPD delta selection must use turn order

- [x] In `applyMaintenance()` (prompt pipeline), build the CPD delta from the already-ordered `sessionMessages` using a pivot index for the target user (slice by position), not by `m.info.id < lastUser.id`.

3) Forced maintenance must make progress

- [x] Extend `applyMaintenance()` with an `aggressive` mode used only on repeated provider `context_length` failures.
- [x] When `forced`, allow CPD update whenever it can advance `cpd.upto` (even if estimates say we're under budget).
- [x] When `aggressive`, allow reasoning truncation to drop a minimum amount even if estimates say we're under budget.
- [x] When `forced`, if no lever can change anything (no tool outputs to trim, no CPD advance possible, no reasoning to drop), return a clear error instead of retrying the same oversize prompt.

4) Remove debug log

- [x] Remove `log.info("SEARCH", ...)` in `packages/opencode/src/server/routes/session.ts`.

5) Verification

- [x] Add regression tests for the FIFO delta bug + file label safety (and forced maintenance progress if feasible).
- [x] Run `bun test` (or the closest existing test command) for `packages/opencode`.

Progress log

- 2026-01-28: Plan created.
- 2026-01-28: Implemented turn-ordered CPD delta selection, forced maintenance progress rules, safe file labels, and removed stray debug log.
- 2026-01-28: Added regression tests; `bun test` passes (924 tests).

Notes

- JS SDK regeneration (`./packages/sdk/js/script/build.ts`) completed.
- `bun run typecheck` now passes; the stale `Session.context` type mismatch in `packages/opencode/src/cli/cmd/tui/routes/session/header.tsx` is resolved.
