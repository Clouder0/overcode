# History Hydration Memory Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce long-session TUI memory growth by removing redundant full-history hydration in low-risk prompt paths, without changing prompt semantics or tool-visible history.

**Architecture:** Add an additive info-only history reader alongside the existing hydrated history API, then switch only the callers that need message metadata or a single final message. Keep `Session.messages()` semantics unchanged for callers that genuinely need full `WithParts[]` data, and defer riskier prompt-scope narrowing until after measuring this smaller fix.

**Tech Stack:** Bun, TypeScript, session prompt loop, Bun test, Solid/OpenTUI consumer paths.

**Note:** User explicitly requested no git worktree; execute in the current workspace.

---

## Progress

- [x] Task 1: Add failing regression tests
- [x] Task 2: Implement info-only history API and low-risk prompt updates
- [ ] Task 3: Verify behavior, review, and record follow-ups

## Current Status

- Added `MessageV2.streamInfo(sessionID)` and shared info sorting in `packages/opencode/src/session/message-v2.ts`.
- Switched low-risk prompt consumers in `packages/opencode/src/session/prompt.ts` away from redundant hydrated history reloads.
- Added focused regressions in `packages/opencode/test/session/message-v2-stream-info.test.ts` and `packages/opencode/test/session/prompt-history-loading.test.ts`.
- Verified locally with:

```bash
bun test test/session/message-v2-stream-info.test.ts test/session/prompt-history-loading.test.ts test/session/prompt-target-resolution.test.ts test/session/subagent-bootstrap.test.ts
```

- Requested subagent spec/code-quality review; no review findings returned before timeout, so final sign-off still depends on direct human review or a later reviewer pass.

---

### Task 1: Add failing regression tests

**Files:**

- Create: `packages/opencode/test/session/message-v2-stream-info.test.ts`
- Create: `packages/opencode/test/session/prompt-history-loading.test.ts`
- Reference: `packages/opencode/src/session/message-v2.ts`
- Reference: `packages/opencode/src/session/prompt.ts`

**Step 1: Write a failing history-order test**

Add a storage-backed test for a new `MessageV2.streamInfo(sessionID)` helper that:

- creates a real session
- persists several user/assistant messages out of chronological insertion order
- asserts `streamInfo()` yields the same newest-first message id order as `MessageV2.stream(sessionID)` without hydrating parts itself

**Step 2: Write a failing no-redundant-reload prompt test**

Add a prompt-loop regression test that:

- creates a real session
- spies on `Session.messages`
- mocks `Provider.getModel()` and `SessionProcessor.create()` so one prompt turn completes deterministically
- asserts the prompt path drops from six hydrated history reads to four in that deterministic flow, proving the redundant in-turn reloads were removed without changing prompt semantics

**Step 3: Run the focused test files to confirm red**

Run:

```bash
bun test test/session/message-v2-stream-info.test.ts test/session/prompt-history-loading.test.ts
```

Expected: FAIL because `streamInfo()` does not exist yet and prompt still performs redundant hydrated history reloads.

---

### Task 2: Implement info-only history API and low-risk prompt updates

**Files:**

- Modify: `packages/opencode/src/session/message-v2.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/message-v2-stream-info.test.ts`
- Test: `packages/opencode/test/session/prompt-history-loading.test.ts`

**Step 1: Add a shared info-ordering helper**

Refactor `message-v2.ts` so the existing `stream()` path and the new `streamInfo()` path share one message-info loading + sorting routine. Keep ordering semantics identical to today.

**Step 2: Add `MessageV2.streamInfo(sessionID)`**

Implement the additive info-only async iterator that yields `MessageV2.Info` newest-first without calling `parts()`.

**Step 3: Replace metadata-only prompt consumers**

In `prompt.ts`, switch these paths to info-only or existing in-scope data:

- `lastModel()`
- `lastAgent()`
- final callback/result selection after the prompt loop
- the redundant `skillMessages` reload inside the active turn

Do **not** change `resolveTools(...messages)` or the main `Session.messages({ sessionID })` load in the hot path in this task.

**Step 4: Run the focused test files**

Run:

```bash
bun test test/session/message-v2-stream-info.test.ts test/session/prompt-history-loading.test.ts
```

Expected: PASS.

**Completed:**

- added `MessageV2.streamInfo(sessionID)` with shared info sorting
- switched `lastModel()` / `lastAgent()` to info-only traversal
- switched final result selection to info-only traversal plus single-message hydration
- removed the redundant `skillMessages` full-session reload inside the active prompt turn

---

### Task 3: Verify behavior, review, and record follow-ups

**Files:**

- Modify: `docs/plans/2026-03-07-history-hydration-memory-fix.md`
- Test: `packages/opencode/test/session/prompt-target-resolution.test.ts`
- Test: `packages/opencode/test/session/message-v2-stream-info.test.ts`
- Test: `packages/opencode/test/session/prompt-history-loading.test.ts`

**Step 1: Run the focused regression suite**

Run:

```bash
bun test test/session/message-v2-stream-info.test.ts test/session/prompt-history-loading.test.ts test/session/prompt-target-resolution.test.ts
```

Expected: PASS.

**Step 2: Run spec/code-quality review using subagents**

Ask one subagent to review spec compliance against this plan and one subagent to review code quality / risk.

**Step 3: Update this plan doc**

Mark completed tasks, record what changed, and list deferred follow-ups:

- possible `findTargetAssistant()` info-first optimization
- possible `wait_agent_message` / doom-loop selective history reads
- possible TUI render-side `streaming` tuning after heap re-measurement

---

## Deferred Follow-Up Plan

This section captures the next recommended work after the shipped low-risk slice.

### Delivered in phase 1

- Added `MessageV2.streamInfo(sessionID)` in `packages/opencode/src/session/message-v2.ts`.
- Reused already-loaded `msgs` instead of reloading `skillMessages` in `packages/opencode/src/session/prompt.ts`.
- Switched `lastModel()`, `lastAgent()`, and final result selection in `packages/opencode/src/session/prompt.ts` to info-first reads.

### Known gaps after review

- `packages/opencode/test/session/prompt-history-loading.test.ts` currently proves the deterministic prompt flow dropped from 6 hydrated `Session.messages()` reads to 4, but it does not yet prove the stricter 2-read target that the original plan described.
- `packages/opencode/test/session/message-v2-stream-info.test.ts` verifies ordering and the intended no-part-hydration contract, but it is weaker than originally planned because it does not stress out-of-order persisted mixed user/assistant messages.
- `packages/opencode/src/session/prompt.ts` `latestResult()` still materializes the full info list before selecting the newest relevant item. This is cheaper than the old hydrated path, but it still leaves avoidable O(n) work for very long sessions.

### Deferred phase 2: tighten the regression tests

**Goal:** make the tests prove the intended optimization directly, not just an implementation detail.

**Files:**

- Modify: `packages/opencode/test/session/message-v2-stream-info.test.ts`
- Modify: `packages/opencode/test/session/prompt-history-loading.test.ts`

**Work:**

- make the `streamInfo()` regression persist mixed user/assistant messages with deliberately non-trivial ordering
- strengthen the prompt regression so it attributes the remaining hydrated reads, instead of only checking a brittle total call count
- document which remaining `Session.messages()` reads are still expected after phase 1 and why

### Deferred phase 3: finish the info-first completion helpers

**Goal:** remove the remaining whole-list info materialization from low-risk completion/lookup helpers.

**Files:**

- Modify: `packages/opencode/src/session/message-v2.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/prompt-target-resolution.test.ts`

**Work:**

- add a small helper that returns the first newest matching info from `streamInfo()` without collecting the whole iterator
- use it in `latestResult()`
- evaluate the same pattern for `findTargetAssistant()` while preserving backlog/target-resolution behavior

### Deferred phase 4: selective tail hydration in the main prompt load

**Goal:** tackle the remaining hot path in `packages/opencode/src/session/prompt.ts:2283` only after the lower-risk wins are fully locked down.

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Modify: `packages/opencode/src/session/message-v2.ts`
- Modify: `packages/opencode/src/tool/wait-agent-message.ts`
- Modify: `packages/opencode/src/session/processor.ts`

**Work:**

- introduce bounded/info-first helpers for prompt-tail selection
- keep `resolveTools(...messages)` semantics unchanged unless a dedicated follow-up proves narrowing is safe
- only hydrate parts for the unsummarized tail / active turn data actually needed by prompt construction, waiting, and doom-loop detection

### Deferred phase 5: renderer-side follow-up only if heap still grows

**Goal:** treat TUI render tuning as a measured follow-up, not as part of the root-cause backend fix.

**Files:**

- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

**Work:**

- profile heap after phases 2-4
- if needed, change completed transcript renderables away from permanent streaming mode
- keep this separate from history-loading changes so memory wins can be attributed cleanly
