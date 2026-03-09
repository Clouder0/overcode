# Skill Dedupe Visible History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make skill dedupe depend only on prior applied skill content that is actually visible in the current short prompt history, plus the current assistant message’s own completed applied skill parts.

**Architecture:** Replace the current hybrid dedupe logic with a single pure classifier that consumes exact prompt-visible assistant history and the current message’s completed parts. Use that classifier inside `SkillTool`, remove prompt-side hidden carry for skill dedupe, and update tests so noop skill results never become future reuse authority.

**Tech Stack:** Bun, TypeScript, Bun test.

**Note:** User explicitly requested current workspace execution; do not use a worktree. Do not create commits unless the user explicitly asks.

---

### Task 1: Freeze the strict visibility contract with failing tests

**Files:**

- Create: `packages/opencode/test/util/skill-dedupe.test.ts`
- Modify: `packages/opencode/test/skill/skill.test.ts`
- Modify: `packages/opencode/test/session/context-length-retry-cleanup.test.ts`
- Modify: `packages/opencode/test/session/skill-context-scope.test.ts`
- Reference: `packages/opencode/src/tool/skill.ts`
- Reference: `packages/opencode/src/session/prompt.ts`

**Step 1: Add helper-level RED cases for reuse authority**

Create `packages/opencode/test/util/skill-dedupe.test.ts` with focused table-style tests for these rules:

```ts
test("same_turn requires visible applied prior load and no marker after it", () => {})
test("near_context ignores prior noop loads", () => {})
test("duplicate_in_turn requires current message completed applied load", () => {})
test("marker after prior load invalidates same_turn and near_context", () => {})
```

**Step 2: Flip the existing integration expectations to the new contract**

Update `packages/opencode/test/skill/skill.test.ts` so these cases now expect `applied` instead of noop:

- same-message duplicate without completed current-message context
- same-turn dedupe across marker boundaries
- no-op chaining that previously promoted future `same_turn` / `near_context`

Update `packages/opencode/test/session/context-length-retry-cleanup.test.ts` so the second retry attempt expects `applied`, because the prior retry attempt is not in the actual prompt-visible history.

Update `packages/opencode/test/session/skill-context-scope.test.ts` with a regression proving hidden same-parent assistant attempts do not seed dedupe when they are outside the transformed prompt scope.

**Step 3: Run the focused tests to verify RED**

Run:

```bash
bun test test/util/skill-dedupe.test.ts test/skill/skill.test.ts test/session/context-length-retry-cleanup.test.ts test/session/skill-context-scope.test.ts
```

Expected: FAIL with the current implementation because cache-only duplicate detection, hidden carry, and noop chaining still exist.

---

### Task 2: Extract a pure visible-history dedupe classifier

**Files:**

- Create: `packages/opencode/src/util/skill-dedupe.ts`
- Create: `packages/opencode/test/util/skill-dedupe.test.ts`
- Reference: `packages/opencode/src/util/skill-projection.ts`

**Step 1: Add the minimal classifier API**

Create a pure helper with an explicit contract like:

```ts
export function classifySkillReuse(input: {
  name: string
  hash: string
  anchorUserID?: string
  visible: MessageV2.WithParts[]
  currentMessageID: string
  current: MessageV2.Part[]
}):
  | { kind: "duplicate_in_turn"; turns: number }
  | { kind: "same_turn"; turns: number }
  | { kind: "near_context"; turns: number }
  | undefined
```

**Step 2: Encode the invariants in the helper**

Implement the helper so it:

- finds the latest **visible applied** assistant skill load for the same `name` and `hash`
- never treats `metadata.applied === false` noop parts as reuse authority
- checks markers after the prior load and invalidates reuse when one exists
- allows `duplicate_in_turn` only when the current assistant message already has a completed applied load
- treats `same_turn` as a stricter subset of visible reuse, not as hidden turn-local memory

**Step 3: Reuse small local predicates instead of duplicating parsing logic**

Keep helpers like “resolve skill name”, “is applied skill part”, and “marker after prior” inside `skill-dedupe.ts` unless extracting them clearly reduces duplication with `packages/opencode/src/util/skill-projection.ts`.

**Step 4: Run the helper tests to verify GREEN**

Run:

```bash
bun test test/util/skill-dedupe.test.ts
```

Expected: PASS.

---

### Task 3: Refactor `SkillTool` to use only visible applied authority

**Files:**

- Modify: `packages/opencode/src/tool/skill.ts`
- Reference: `packages/opencode/src/util/skill-dedupe.ts`
- Reference: `packages/opencode/src/util/skill-projection.ts`

**Step 1: Remove cache-only duplicate behavior**

Delete the in-memory duplicate cache in `packages/opencode/src/tool/skill.ts` (`Instance.state`, cache keys, and `duplicate_in_turn` fast path). Under the new contract, duplicate detection must come from current-message completed applied parts, not hidden global state.

**Step 2: Stop treating noop skill parts as future reuse anchors**

Replace the current `prior` search with the pure classifier from `skill-dedupe.ts`. The tool should still emit noop results for `duplicate_in_turn`, `same_turn`, and `near_context`, but only when the helper confirms a visible applied authority.

**Step 3: Preserve tool-enablement behavior**

Keep the existing `enabledTools` behavior intact: if a visible/applied prior load causes a noop, the requested tools should still be enabled for the session exactly as they are today.

**Step 4: Run focused tool tests**

Run:

```bash
bun test test/skill/skill.test.ts test/util/skill-dedupe.test.ts
```

Expected: PASS.

---

### Task 4: Remove prompt-side hidden carry from skill dedupe

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Modify: `packages/opencode/test/session/context-length-retry-cleanup.test.ts`
- Modify: `packages/opencode/test/session/skill-context-scope.test.ts`

**Step 1: Simplify `skillContext` to exact prompt-visible history**

Delete `carrySkillMessages` and `retrySkillMessages` from `packages/opencode/src/session/prompt.ts`. Build `skillContext.messages` from the exact transformed `sessionMessages.filter(MessageV2.modelVisible)` set only.

**Step 2: Keep turn identity, remove hidden history authority**

Continue passing `turnContext.anchorUserID`, but do not pass same-parent hidden assistant attempts or retry-local hidden attempts as dedupe authority.

**Step 3: Verify the retry behavior under the strict rule**

Run:

```bash
bun test test/session/context-length-retry-cleanup.test.ts test/session/skill-context-scope.test.ts
```

Expected: PASS, with retries re-applying the skill unless the prior applied load is genuinely visible in the prompt.

---

### Task 5: Align prompt copy and full verification

**Files:**

- Modify: `packages/opencode/src/session/system.ts`
- Test: `packages/opencode/test/util/skill-dedupe.test.ts`
- Test: `packages/opencode/test/skill/skill.test.ts`
- Test: `packages/opencode/test/session/context-length-retry-cleanup.test.ts`
- Test: `packages/opencode/test/session/skill-context-scope.test.ts`
- Test: `packages/opencode/test/session/processor-doom-loop.test.ts`
- Test: `packages/opencode/test/session/message-v2.test.ts`

**Step 1: Tighten the system instruction text**

Update the skill instruction in `packages/opencode/src/session/system.ts` so it no longer implies that any noop result satisfies the entire unresolved turn unconditionally. Narrow it to “already active in the current visible context / current attempt” language.

**Step 2: Run the focused regression set**

Run:

```bash
bun test test/util/skill-dedupe.test.ts test/skill/skill.test.ts test/session/context-length-retry-cleanup.test.ts test/session/skill-context-scope.test.ts test/session/processor-doom-loop.test.ts test/session/message-v2.test.ts
```

Expected: PASS.

**Step 3: Run full package verification**

Run:

```bash
bun test
bun run typecheck
```

Working directory for both commands:

```bash
packages/opencode
```

Expected: PASS.
