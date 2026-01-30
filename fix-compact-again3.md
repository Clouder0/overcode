# Fix Compact Again (v3)

Goal: close remaining compaction/summarize correctness gaps found in review (race windows, atomicity, TTL behavior), plus a small TUI compaction UX polish.

This document is the source of truth for plan + progress. Check items as they land.

Current status (2026-01-29): All planned fixes complete; typecheck + tests pass.

## Issues Found (From Review)

1) `/session/:id/abort` can leave `SessionStatus=busy` forever when it races with the `/session/:id/summarize` `finally` block.
2) `SessionCPD.set` monotonic guard is non-atomic under concurrency.
3) Manual compaction ACTIVE_TTL eviction can drop the manual entry mid-flight (breaks abort + re-opens overlap risk).
4) `/session/:id/context` token estimate can throw on `JSON.stringify`.
5) `SessionCompaction.marker()` assumes `time.created` exists; malformed marker files can throw + never be cleared.
6) TUI "Context updated" toast can fire on session switch (false positive).

## Plan

### 1) Fix `/abort` stuck-busy race

- [x] Reorder `/session/:id/summarize` cleanup so `endManual()` happens before setting `SessionStatus=idle`.
- [ ] (Optional hardening) prevent `/abort` from re-asserting `busy` when the session was already idle (skipped; reorder removes the idle window).
- [x] Add regression test ensuring summarize never sets `idle` while manual is still active.

### 2) Make `SessionCPD.set` atomic

- [x] Add a storage helper that can update-or-create under a single write lock (handles missing file).
- [x] Rewrite `SessionCPD.set` to do the monotonic check inside that write-locked section.
- [x] Add concurrency test verifying `SessionCPD.set` uses atomic upsert.

### 3) Manual compaction TTL semantics

- [x] Remove ACTIVE_TTL eviction so the manual entry cannot disappear mid-flight.
- [x] Add a test that simulates time passing and confirms manual state remains.

### 4) Harden `/session/:id/context` estimate

- [x] Mirror `prompt.ts` behavior: guard `JSON.stringify` in server-side estimate computation.

### 5) Harden marker parsing

- [x] Treat invalid/missing `time.created` marker records as stale and clear them.
- [x] Add test for malformed marker record removal.

### 6) TUI: suppress CPD toast on session switch

- [x] Key or reset CPD toast state by `sessionID` so navigation doesn’t trigger "Context updated".

### 7) Verification

- [x] `bun run typecheck` in `packages/opencode`
- [x] `bun test` in `packages/opencode`

## Progress log

- Started: 2026-01-29

- 2026-01-29: Reordered summarize cleanup to end manual compaction before setting idle
- 2026-01-29: Added regression test: summarize must not set idle while manual is active
- 2026-01-29: Added Storage.upsert and switched SessionCPD.set to atomic monotonic updates
- 2026-01-29: Removed manual compaction ACTIVE_TTL eviction + added coverage
- 2026-01-29: Hardened /session/:id/context estimate JSON stringify
- 2026-01-29: Hardened compaction marker parsing + added malformed marker test
- 2026-01-29: TUI: suppress CPD toast on session switch
- 2026-01-29: Verified `bun run typecheck` + `bun test` in `packages/opencode`
