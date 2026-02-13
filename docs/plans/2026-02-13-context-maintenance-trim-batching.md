# Context Maintenance Trim Batching Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce provider prompt-cache invalidations by making tool-output trimming less frequent and more batchy, while preserving correctness of the CPD + tail context pipeline.

**Architecture:** Modify `SessionPrompt`'s preflight context-maintenance (`applyMaintenance`) to (1) trim only model-visible tool outputs, (2) when trimming is required, free overage + headroom (a minimum batch) instead of "just enough", and (3) base markers/decisions on actual prompt-size reduction (estimate delta) rather than only per-part estimates.

---

## Progress

- [x] Task 1: Add maintenance diagnostics logging
- [x] Task 2: Pure trim-sizing helper + unit tests
- [x] Task 3: Trim only model-visible tool outputs
- [x] Task 4: Use actual estimate-delta for markers and gating
- [x] Task 5: Integration test to prevent micro-trim loops
- [ ] Task 6 (optional): Make headroom tunable via config

---

## Constraints / Non-Goals

- Do not change manual `/compact` behavior.
- Do not change forced context-length recovery semantics.
- Keep changes minimal/local; avoid unrelated refactors.
- Do not change per-tool output truncation (`packages/opencode/src/tool/truncation.ts`).

## Testing Notes

Run tests from `packages/opencode/`:

```bash
bun test
```

---

### Task 1: Add lightweight observability for maintenance decisions

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`

**Steps:**

1. Add `log.debug` emitted only when a tool trim marker is produced.
2. Fields: `cause`, `forced`, `recovering`, `aggressive`, `estimateBefore`, `estimateAfterTrim`, `overage`, `headroom`, `excessTarget`, `trimmedCount`, `freedEstimate`, `freedActual`.
3. Run `bun test`.

---

### Task 2: Make trim math testable (pure helper + unit tests)

**Files:**

- Create: `packages/opencode/src/session/maintenance.ts`
- Test: `packages/opencode/test/session/maintenance-excess.test.ts`
- Modify: `packages/opencode/src/session/prompt.ts`

---

### Task 3: Trim only model-visible tool outputs (avoid no-op trims)

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/maintenance-model-visible.test.ts`

---

### Task 4: Base trim markers and decisions on actual estimate delta

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`

---

### Task 5: Integration test for trim batching

**Files:**

- Create: `packages/opencode/test/session/trim-batching.test.ts`
