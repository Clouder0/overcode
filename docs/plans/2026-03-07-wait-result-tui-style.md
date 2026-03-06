# Wait Result TUI Style Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render inbound `Wait result` messages with success styling when a wait resolves, and show timeout styling only when the wait actually timed out.

**Architecture:** Add explicit `waitStatus` metadata when inbound `wait_result` messages are persisted in the session layer, then route TUI message styling through a tiny pure helper that maps message metadata to presentation state. Keep the existing raw-text rendering for wait-result bodies so agent ids like `ses_...` do not get mangled by markdown parsing.

**Tech Stack:** Bun, TypeScript, SolidJS, OpenTUI, Bun test.

---

### Task 1: Lock the presentation rules in a focused TUI unit test

**Files:**

- Create: `packages/opencode/src/cli/cmd/tui/util/wait-result.ts`
- Create: `packages/opencode/test/cli/tui/wait-result.test.ts`
- Reference: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

**Step 1: Write a failing helper test for resolved wait results**

Add a test that passes a synthetic incoming system message part with `opencode.messageType = "wait_result"` and `opencode.waitStatus = "resolved"`, then asserts the helper returns:

- a success tone
- no timeout badge
- a resolved-specific icon instead of the timeout icon

**Step 2: Write a failing helper test for timed-out wait results**

Add a second test that asserts a timed-out wait result still maps to:

- an error tone
- the timeout badge
- the timeout icon

**Step 3: Run the focused test file to confirm failure**

Run:

```bash
bun test test/cli/tui/wait-result.test.ts
```

Expected: FAIL because the helper does not exist yet.

**Step 4: Commit the red test**

```bash
git add packages/opencode/test/cli/tui/wait-result.test.ts
git commit -m "test: reproduce wait result tui styling bug"
```

### Task 2: Persist structured wait status on inbound wait-result messages

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Modify: `packages/opencode/test/session/inbox-consumption-nonterminal.test.ts`
- Reference: `packages/opencode/src/session/message-parser.ts`

**Step 1: Write a failing session test for wait-result metadata**

Extend the existing inbound wait-result coverage so it asserts the persisted `message` part metadata includes:

- `opencode.messageType = "wait_result"`
- `opencode.waitStatus = "resolved" | "timedOut"`

Use real formatted wait-result text from `MessageParser.formatWaitResult(...)` rather than a handcrafted string if that keeps the fixture closer to production behavior.

**Step 2: Derive `waitStatus` at the ingestion boundary**

In `prompt.ts`, when converting a delivered `wait_result` into a `MessageV2.MessagePart`, derive the status once and persist it into `metadata.opencode.waitStatus`.

Keep this logic small and boundary-focused:

- `resolved` when the wait-result text indicates `Wait resolved`
- `timedOut` when the wait-result text indicates `Wait timed out`
- omit the field when the message is not a wait result or cannot be classified safely

**Step 3: Run the targeted session test**

Run:

```bash
bun test test/session/inbox-consumption-nonterminal.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/session/inbox-consumption-nonterminal.test.ts
git commit -m "refactor: persist wait result status metadata"
```

### Task 3: Route TUI message styling through the pure wait-result helper

**Files:**

- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Modify: `packages/opencode/src/cli/cmd/tui/util/wait-result.ts`
- Test: `packages/opencode/test/cli/tui/wait-result.test.ts`

**Step 1: Implement the minimal helper**

Create a pure helper that accepts the incoming message-part shape needed for wait-result detection and returns only the presentation state the component needs, such as:

- whether the message is a wait result
- which icon to use
- whether to show the timeout badge
- which semantic tone to apply (`success`, `warning`, `error`, or none)

Prefer metadata-driven behavior, with a conservative fallback for unknown wait-result states.

**Step 2: Replace the current boolean-based styling in `MessagePartComponent`**

Update the component so resolved wait results no longer inherit the generic warning/timed-out styling path. Use the helper output for:

- left border color
- header arrow/icon
- peer label color
- timeout badge visibility

Do not change the raw text body rendering path for wait results.

**Step 3: Run the focused TUI test file**

Run:

```bash
bun test test/cli/tui/wait-result.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/opencode/src/cli/cmd/tui/routes/session/index.tsx packages/opencode/src/cli/cmd/tui/util/wait-result.ts packages/opencode/test/cli/tui/wait-result.test.ts
git commit -m "fix: style resolved wait result messages in tui"
```

### Task 4: Verify adjacent behavior still matches the existing wait UX

**Files:**

- Modify: `packages/opencode/test/cli/tui/transcript.test.ts`
- Reference: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Reference: `packages/opencode/src/cli/cmd/tui/util/transcript.ts`

**Step 1: Add a light regression test for system wait-result transcript output**

Assert that transcript formatting still renders the wait-result message text without inventing a timeout suffix for a resolved wait result.

**Step 2: Run the small verification suite**

Run:

```bash
bun test test/cli/tui/wait-result.test.ts test/cli/tui/transcript.test.ts test/session/inbox-consumption-nonterminal.test.ts
```

Expected: PASS.

**Step 3: Run one broader wait-related test for confidence**

Run:

```bash
bun test test/session/message-v2.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add packages/opencode/test/cli/tui/transcript.test.ts
git commit -m "test: cover wait result message presentation"
```

### Task 5: Final verification before handoff

**Files:**

- Reference: `packages/opencode/src/session/prompt.ts`
- Reference: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Reference: `packages/opencode/src/cli/cmd/tui/util/wait-result.ts`

**Step 1: Run the final focused verification commands**

Run:

```bash
bun test test/cli/tui/wait-result.test.ts test/cli/tui/transcript.test.ts test/session/inbox-consumption-nonterminal.test.ts test/session/message-v2.test.ts
```

Expected: PASS.

**Step 2: Sanity-check the behavior manually if convenient**

If you run the TUI manually, confirm:

- resolved wait-result messages no longer show `(timed out)`
- resolved wait-result messages no longer use the warning/error presentation
- timed-out wait-result messages still look like timeouts

**Step 3: Summarize the invariant in the final handoff**

State explicitly that:

```text
`wait_result` is a transport/message type, not a timeout state.
Presentation must follow explicit wait status, not the fact that the message came from the wait-result channel.
```
