# Fix Plan: Compaction / CPD / TUI Hardening (Round 2)

Date started: 2026-01-28

Scope
- TUI-focused compaction reliability. This includes the server endpoints and session pipeline pieces that the TUI depends on:
  - manual `/compact` (server `POST /session/:id/summarize`)
  - auto maintenance (prompt-loop trimming / CPD update / reasoning truncation)
  - CPD storage + injection
  - revert interactions
  - TUI command UX + status badges

Non-goals
- Re-designing the CPD format or prompt architecture.
- Re-introducing legacy “compaction request message” flows.

Quality bar (production invariants)
- FIFO target selection is consistent across:
  - prompt loop
  - `GET /session/:id/context`
  - `POST /session/:id/summarize`
- CPD boundary (`cpd.upto`) is monotonic (never moves backwards).
- Any user-visible flag (TRIM / THINK / RCTX / CMP) is auditable:
  - a transcript marker exists for the latest occurrence
  - stale state self-heals (crashes do not leave CMP/marker lingering indefinitely)
- Manual compaction is:
  - non-concurrent
  - observable (busy status + toasts)
  - cancellable via existing `POST /session/:id/abort`

Primary risks
- Circular imports between server/routes/session and session modules (breaks tests and can break prod bundling).
- Overlapping compactions (prompt-loop maintenance vs manual summarize) causing CPD regression.
- Marker/state drift (flags set without markers; markers linger after crashes).

## Problem list (verified)

1) Manual `/compact` can be a no-op after assistant errors
- `/session/:id/summarize` used a stricter “answered” predicate than the prompt loop.

2) Manual `/compact` ignored bootstrap/replay synthetic user text
- `/summarize` dropped synthetic bootstrap/replay, making FIFO selection diverge.

3) Manual `/compact` was fire-and-forget in TUI
- No await/catch, no in-flight guard, silent failures.

4) Manual `/compact` lacked server-side cancellation and reminder markers
- TUI interrupt only canceled prompt loop; messages arriving mid-compact didn't get reminders.

5) CPD can regress and revert cleanup can leave stale flags
- CPD set is last-writer-wins.
- Revert cleanup removed messages/parts but didn’t clear/reconcile `cpd` + `session.context.{trim,think,rctx}`.

6) Marker / state drift
- Prune sets `trim=true` without a transcript marker.
- CPD-update sets `rctx=true` without a transcript marker.

7) Stale “CMP” and stale compaction markers after crashes
- `time.compacting` can persist indefinitely.
- storage marker TTL can mis-fire “arrived while compacting” reminders long after the fact.

## Production plan

### Phase 0: Unblock Tests (break import cycle)

Goal: ensure importing `src/session/*` in tests does not import `src/server/routes/session.ts` in a partially-initialized cycle.

- [x] Break `plugin -> server -> routes/session -> SessionCPD -> session -> prompt -> plugin` cycle.
  - Preferred: remove static `import { Server } ...` from `packages/opencode/src/plugin/index.ts` and dynamically import it inside the lazy state initializer.
- [x] Run at least one pure session unit test (`test/session/cpd-monotonic.test.ts`) to confirm no module-init crash.

### Phase 1: Unify FIFO Selection Logic (server + prompt)

- [x] Extract shared helpers:
  - `isAssistantAnswered(info)`
  - `isUserRelevant(msg)` (includes bootstrap/replay synthetic)
- [x] Update `POST /session/:id/summarize` and `GET /session/:id/context` to use shared helpers.
- [x] Tests:
  - [x] `/summarize` advances CPD past completed assistant errors.
  - [x] `/summarize` treats bootstrap/replay synthetic user text as relevant.

### Phase 2: Manual summarize concurrency + cancellation + reminders

- [x] Add per-session manual compaction lock + AbortController.
- [x] Wire `POST /session/:id/abort` to cancel manual compaction.
- [x] Set session status `busy` while `/summarize` runs; always restore `idle`.
- [x] Set/clear storage compaction marker during `/summarize` so inbound delivered messages get reminders.
- [x] Tests:
  - [x] Delivered message during `/summarize` receives reminder (storage marker path).
  - [x] `session.abort` cancels in-flight `/summarize` and clears busy + marker + `time.compacting`.

### Phase 3: CPD safety (monotonic + revert hygiene)

- [x] Enforce monotonic `cpd.upto` in `SessionCPD.set`.
- [x] Revert cleanup reconciles `cpd` + `trim/think/rctx` flags.
- [x] Tests:
  - [x] Out-of-order `SessionCPD.set` calls do not regress `upto`.
  - [x] Revert cleanup clears CPD when reverting past `cpd.upto`.

### Phase 4: Auto maintenance correctness + marker consistency

- [x] Auto maintenance clears `time.compacting` conditionally (only if still the same started timestamp).
- [x] Include bootstrap/replay synthetic user text when assembling CPD deltas/requests (manual summarize + auto maintenance).
- [x] Emit transcript markers when:
  - prune trims tool outputs (trim marker)
  - CPD update detects provider reasoning-context rejection (rctx marker)
- [x] Tests (best-effort):
  - [x] rctx marker is written when rctx flag flips false -> true.
  - [x] prune writes trim marker when it prunes.

### Phase 5: Stale-state self-healing

- [x] Reduce/align compaction marker TTL to avoid long-lived false reminders.
- [x] Treat stale `time.compacting` as inactive (server-side and/or TUI-side).
- [ ] Manual verification:
  - [ ] Kill process mid-compact, restart, no CMP badge after TTL and no reminder markers after TTL.

### Phase 6: TUI command UX

- [x] Make `/compact` await and surface errors.
- [x] Add an in-flight guard (disable when session is busy or compacting).
- [x] TUI CMP badge uses “recent compacting” (not just presence of timestamp).
- [ ] Manual verification:
  - [ ] Spam keybind: only one request is fired.
  - [ ] Provider/network error: visible toast.
  - [ ] Interrupt during manual compact: request cancels, CMP clears.

## Progress log

- 2026-01-28: Phase 1 complete (shared FIFO helpers + tests).
- 2026-01-28: Phase 2 complete (manual summarize lock/cancel/markers + tests).
- 2026-01-29: Phase 0 complete (broke plugin/server import cycle; session unit tests run).
- 2026-01-29: Phase 3 complete (CPD monotonic + revert cleanup tests).
- 2026-01-29: Phase 4 complete (conditional CMP clear; rctx+trim markers; bootstrap/replay text in deltas).
- 2026-01-29: Phase 5 implemented (marker TTL + stale CMP handling); manual verification pending.
- 2026-01-29: Phase 6 implemented (await /compact, guard, toasts); manual verification pending.
