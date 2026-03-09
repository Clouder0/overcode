# Service Tier Normal Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop sending OpenAI `service_tier` for normal mode requests while preserving FAST mode as the explicit opt-in path for `priority`.

**Architecture:** Keep the fix small and local. Change the TUI fast-mode toggle so disabling FAST mode clears the stored service tier instead of writing `"auto"`, then harden the LLM option assembly so normal-mode values do not serialize `serviceTier` downstream. This keeps the behavioral contract aligned at both the UI boundary and the provider-options boundary.

**Tech Stack:** Bun, TypeScript, Solid/OpenTUI, Bun test.

**Note:** User explicitly requested current workspace execution; do not use a worktree.

---

## Progress

- [x] Task 1: Lock the spec with failing regression tests
- [x] Task 2: Implement the minimal behavior change
- [x] Task 3: Verify no regressions in the narrowed behavior

## Current Status

- Updated `packages/opencode/src/cli/cmd/tui/component/prompt/fast-mode.ts` so turning FAST mode off clears the stored tier instead of writing `"auto"`.
- Updated `packages/opencode/src/provider/openai/service-tier.ts` so `"auto"` is treated as an omitted/default tier and is not serialized downstream.
- Added and updated focused regressions in `packages/opencode/test/tui/fast-mode.test.ts`, `packages/opencode/test/session/llm-service-tier.test.ts`, and `packages/opencode/test/provider/openai-service-tier.test.ts`.
- Verified locally with:

```bash
bun test test/provider/openai-service-tier.test.ts test/tui/fast-mode.test.ts test/session/llm-service-tier.test.ts
```

### Task 1: Lock the spec with failing regression tests

**Files:**

- Modify: `packages/opencode/test/tui/fast-mode.test.ts`
- Modify: `packages/opencode/test/session/llm-service-tier.test.ts`
- Reference: `packages/opencode/src/cli/cmd/tui/component/prompt/fast-mode.ts`
- Reference: `packages/opencode/src/session/llm.ts`

**Step 1: Write a failing fast-mode toggle test**

Change the toggle expectation so disabling FAST mode returns `undefined`, not `"auto"`.

**Step 2: Write a failing LLM normal-mode omission test**

Add a regression proving that when a request is not in FAST mode, `providerOptions.openai.serviceTier` is omitted instead of being forwarded as `"auto"`.

**Step 3: Run focused tests to verify RED**

Run:

```bash
bun test test/tui/fast-mode.test.ts test/session/llm-service-tier.test.ts
```

Expected: FAIL because the current implementation still toggles to `"auto"` and still forwards explicit `"auto"` downstream.

---

### Task 2: Implement the minimal behavior change

**Files:**

- Modify: `packages/opencode/src/cli/cmd/tui/component/prompt/fast-mode.ts`
- Modify: `packages/opencode/src/provider/openai/service-tier.ts`
- Test: `packages/opencode/test/tui/fast-mode.test.ts`
- Test: `packages/opencode/test/session/llm-service-tier.test.ts`
- Test: `packages/opencode/test/provider/openai-service-tier.test.ts`

**Step 1: Clear FAST-off state at the UI helper**

Make `nextFastModeTier()` return `undefined` when toggling off from `"priority"`.

**Step 2: Strip normal-mode tier values at the OpenAI tier boundary**

Update OpenAI tier sanitization so `"auto"` is treated as normal mode and omitted from downstream provider options.

**Step 3: Run focused tests to verify GREEN**

Run:

```bash
bun test test/provider/openai-service-tier.test.ts test/tui/fast-mode.test.ts test/session/llm-service-tier.test.ts
```

Expected: PASS.

---

### Task 3: Verify no regressions in the narrowed behavior

**Files:**

- Modify: `docs/plans/2026-03-09-service-tier-normal-mode.md`
- Test: `packages/opencode/test/provider/openai-service-tier.test.ts`
- Test: `packages/opencode/test/tui/fast-mode.test.ts`
- Test: `packages/opencode/test/session/llm-service-tier.test.ts`

**Step 1: Run the focused verification set**

Run:

```bash
bun test test/provider/openai-service-tier.test.ts test/tui/fast-mode.test.ts test/session/llm-service-tier.test.ts
```

Expected: PASS.

**Step 2: Update this plan with status**

Record the delivered behavior and any deferred follow-up, if needed.
