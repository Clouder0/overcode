# Fix Compact Again (v4)

Goal: address remaining production-grade correctness/UX issues around compaction (auto maintenance + manual summarize), especially silent failure modes and corrupted storage recovery.

Current status (2026-01-29): All planned fixes complete; typecheck + tests pass.

## Confirmed Issues

1) Prompt during manual `/session/:id/summarize` can persist a user message but never produce a reply (and TUI swallows the error).
2) `Storage.upsert` doesn’t recover from corrupted JSON; CPD writes can become permanently broken.
3) Compaction marker parsing is only partially validated; corrupt marker JSON is never cleaned.
4) Manual summarize can wedge a session indefinitely if abort is not respected (no TTL now).
5) Delivered-message reminders (“arrived while compacting”) are incomplete for manual summarize (early window + TTL reliance).

## Decisions (Semantics)

- Treat manual summarize as “exclusive”: reject new prompt/command submissions while manual summarize is active.
  - Rationale: the streaming `/session/:id/message` endpoint must either reply or fail; persisting a user message without starting the loop is worse than returning 409.

## Plan

### 1) Reject prompts during manual summarize (no persisted orphan prompts)

- [x] Add a guard in `SessionPrompt.prompt` that throws `Session.BusyError` when `SessionCompaction.manual(sessionID)` is active.
- [x] Add a second guard immediately before persisting the user message in `createUserMessage` to minimize race windows.
- [x] Server: pre-check manual summarize in `POST /session/:id/message` and `POST /session/:id/prompt_async`.
- [x] Fix `/prompt_async` to never create unhandled promise rejections (always `.catch` any fire-and-forget call).
- [x] TUI: handle prompt submission errors (toast on 409 busy + generic failure) instead of `.catch(() => {})`.
- [x] Add regression tests:
  - [x] Server: `/message` during in-flight manual summarize returns 409 and does not create a new user message.
  - [x] Server: `/prompt_async` during manual summarize returns 409 and does not create a message.

### 2) Make storage writes resilient to corrupted JSON + safer under crash

- [x] Update `Storage.upsert` to recover from invalid JSON (treat as missing; rename to `.corrupt.<ts>`).
- [x] Ensure storage listing ignores non-JSON files (avoid `.tmp` / `.corrupt` breaking listing).
- [ ] (Optional) Switch JSON writes to a temp-file + rename strategy, without polluting `.json` globs (skipped).
- [x] Add tests:
  - [x] Corrupted CPD JSON is healed by `SessionCPD.set`.

### 3) Harden compaction marker parsing

- [x] In `SessionCompaction.marker`, validate `requestID` (string) and `startedAt` (number).
- [x] If marker JSON is corrupted (parse error), remove it.
- [x] Add tests for corrupt JSON + invalid shape.

### 4) Manual summarize wedge recovery

- [x] Add a timeout to manual summarize operations (combine `entry.abort.signal` with `AbortSignal.timeout`).
- [x] Add a “force abort” capability to `/session/:id/abort` (query `?force=true`): clear manual compaction state + marker + `time.compacting`.
- [x] Gate summarize writes (CPD set, rctx marker) on “is this request still the active manual request?” so force-abort cannot result in late writes.
- [x] Add tests:
  - [x] Force abort clears busy/manual state and allows prompts afterward.
  - [x] Late summarize completion after force abort does not write CPD.

### 5) Delivered-message reminders during manual summarize

- [x] In `persistDeliveredMessage`, treat manual compaction (`SessionCompaction.manual`) as compacting state (not just marker/prompt-loop compaction).
- [x] Avoid showing `Compaction request: pending` (omit the line until requestID is known).
- [x] Add test: delivered message during manual summarize (before marker write) gets a reminder.

### 6) Verification

- [x] `bun run typecheck` in `packages/opencode`
- [x] `bun test` in `packages/opencode`

## Progress log

- Started: 2026-01-29

- 2026-01-29: Reject prompt submissions during manual summarize (no orphan user messages)
- 2026-01-29: TUI: surface prompt submission failures (busy + generic errors)
- 2026-01-29: Storage: `upsert` heals corrupt JSON; `list` ignores non-JSON files
- 2026-01-29: Marker: validate shape and clear corrupt marker JSON
- 2026-01-29: Manual summarize: add timeout signal + `abort?force=true` recovery + gate late writes
- 2026-01-29: Delivered message reminders use manual compaction state; omit pending request line
- 2026-01-29: Verified `bun run typecheck` + `bun test` in `packages/opencode`
