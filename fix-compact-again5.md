# Fix Compact Again (v5)

Goal: address the remaining compaction-adjacent production issues found in the latest review (unsafe query parsing, shell lock semantics, abort side-effects, storage race robustness, and reminder metadata shape).

Current status (2026-01-31): Completed; verification passed.

## Confirmed Issues

1) `/session/:id/abort?force=...` parsing is unsafe: `?force=false` becomes `true` with `z.coerce.boolean()`.
2) `SessionPrompt.shell` likely leaves the prompt-loop lock stuck (uses forced cancel) and bypasses manual summarize exclusivity; TUI also doesn’t catch shell errors.
3) Non-force manual summarize abort can still commit CPD writes if the underlying provider ignores abort and returns normally.
4) `Storage.upsert` can still throw if the file disappears between `exists()` and `text()` (cross-process deletion).
5) Delivered-message reminder metadata currently sets `requestID: "pending"`; should use an explicit `pending` flag and omit `requestID` until known.

## Plan

### 1) Make `force` parsing explicit and safe

- [x] Replace `z.coerce.boolean()` with an explicit string union parser (accept `true|false|1|0`, reject unknown).
- [x] Add regression test: `?force=false` does not force-clear manual state.

### 2) Fix shell lock semantics + manual summarize exclusivity

- [x] In `SessionPrompt.shell`, reject when `SessionCompaction.manual(sessionID)` is active.
- [x] Ensure shell releases its session prompt-loop lock on completion (`cancel(..., { force: false })`).
- [x] Treat shell as human input that interrupts WaitPolicy (clear wait + mark interrupted).
- [x] Server: optionally pre-check manual summarize in `POST /session/:id/shell` (handled via `SessionPrompt.shell` BusyError).
- [x] TUI: add `.catch` handling for `sdk.client.session.shell` and show a toast on 409 busy.
- [x] Add tests:
  - [x] Shell does not wedge the session (shell → prompt works).
  - [x] Shell during manual summarize returns 409.

### 3) Abort must mean “no writes” for manual summarize

- [x] In `/session/:id/summarize`, before any CPD/flag writes, bail out if `abort.aborted`.
- [x] Add regression test: abort (non-force) prevents `SessionCPD.set` even if `SessionCPD.update` returns after abort.

### 4) Harden `Storage.upsert` against disappearing files

- [x] Treat ENOENT from `file.text()` as “missing” and continue with `create()`.
- [x] Add a small unit regression (if feasible) or at least keep behavior robust without tests (implemented robust behavior; no dedicated unit test).

### 5) Fix reminder metadata shape for pending request

- [x] Change reminder metadata to `{ pending: true, startedAt }` when requestID isn’t known.
- [x] Update pending reminder test to assert `pending: true` instead of `requestID === "pending"`.

### 6) Verification

- [x] `bun run typecheck` in `packages/opencode`
- [x] `bun test` in `packages/opencode`

## Progress log

- Started: 2026-01-29
- 2026-01-31: Recovered from crash-corrupted `packages/opencode/src/server/routes/session.ts` (trailing NUL bytes), then completed items 1-5 and re-ran typecheck/tests.
