# Multi-Agent Send Continuation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent the prompt loop from treating a send-only multi-agent handoff as a terminal answer when the session still needs another scheduling decision.

**Architecture:** Keep provider `finish` truthful and move terminality decisions to one shared helper that inspects the full assistant message, not just `info.finish`. A completed outgoing agent-message part becomes a durable handoff signal: if the assistant only handed work off and did not produce a local terminal answer, the parent user stays pending for the next loop pass. Reuse the existing wait/non-terminal behavior; do not patch this by mutating provider finish reasons unless the tests prove the full-message approach is insufficient.

**Tech Stack:** Bun, TypeScript, `ai` SDK message model, session prompt loop, session relevance helpers, Bun test.

---

### Task 1: Lock the root cause and the negative control in tests

**Files:**

- Modify: `packages/opencode/test/session/subagent-send-continues.test.ts`
- Modify: `packages/opencode/test/session/prompt-target-resolution.test.ts`
- Reference: `packages/opencode/src/tool/send-agent-message.ts`

**Step 1: Keep the failing send-handoff regression**

Preserve the integration test that proves the bug:

- first assistant turn successfully calls `send_agent_message`
- the same assistant is marked `finish = "stop"`
- `SessionPrompt.loop()` should still schedule a second turn
- current behavior fails with `Expected: 2 / Received: 1`

**Step 2: Keep the parked-wait negative control**

Preserve the prompt-target test that proves the earlier parked-wait suspicion is not the primary bug. That test should continue to pass while the send-handoff regression stays red.

**Step 3: Run the focused red/green split**

Run:

```bash
bun test test/session/subagent-send-continues.test.ts -t "subagent loop continues after send_agent_message even with terminal finish"
bun test test/session/prompt-target-resolution.test.ts -t "prompt does not resolve with a parked wait assistant for the requested user"
```

Expected:

- first command: FAIL with `Expected: 2` / `Received: 1`
- second command: PASS

**Step 4: Commit the regression shape**

```bash
git add packages/opencode/test/session/subagent-send-continues.test.ts packages/opencode/test/session/prompt-target-resolution.test.ts
git commit -m "test: reproduce terminal send handoff regression"
```

### Task 2: Add a pure full-message terminality spec test

**Files:**

- Create: `packages/opencode/test/session/relevance.test.ts`
- Reference: `packages/opencode/src/session/relevance.ts`
- Reference: `packages/opencode/src/session/message-v2.ts`

**Step 1: Write the failing unit-level spec**

Add a small pure test file that constructs `MessageV2.WithParts` fixtures and asserts the intended contract:

- a completed assistant with `finish = "stop"` and no outgoing agent handoff is answered
- a completed assistant with `finish = "stop"` and an outgoing agent-message part, but no relevant local text, is **not** answered
- a completed assistant with `finish = "stop"`, an outgoing agent-message part, and relevant local text is answered
- a completed assistant with `finish = "tool-calls"` stays non-terminal

Prefer tiny literal fixtures over mocked processors.

**Step 2: Run the unit test to verify it fails for the right reason**

Run:

```bash
bun test test/session/relevance.test.ts
```

Expected: FAIL because the new full-message helper does not exist yet or still classifies the send-handoff case as answered.

**Step 3: Commit the red unit test**

```bash
git add packages/opencode/test/session/relevance.test.ts
git commit -m "test: specify assistant handoff terminality"
```

### Task 3: Implement a single source of truth for assistant disposition

**Files:**

- Modify: `packages/opencode/src/session/relevance.ts`
- Test: `packages/opencode/test/session/relevance.test.ts`
- Reference: `packages/opencode/src/tool/send-agent-message.ts`

**Step 1: Add tiny helper predicates**

In `relevance.ts`, add focused helpers that inspect a full assistant message:

- `hasAgentHandoff(msg)` → true when `msg.parts` includes `type === "message"`, `direction === "outgoing"`, `peerType === "agent"`
- `hasRelevantLocalText(msg)` → true when `msg.parts` includes a `text` part that `isTextRelevant(...)` already considers visible/non-ignored

Do not change the send tool protocol yet; use the durable outgoing `MessagePart` that already exists.

**Step 2: Add a full-message answered helper**

Add a new helper such as `isAssistantAnsweredMessage(msg)` with this contract:

- false if the assistant is incomplete
- true on terminal assistant error (preserve current FIFO behavior)
- false for `finish = "tool-calls"` or `finish = "unknown"`
- false for a completed send-handoff message with no relevant local text
- true for other completed terminal assistant messages

Keep the existing info-only helper only where it is still genuinely needed; do not mutate provider `finish` to synthetic values as the primary fix.

**Step 3: Run the unit test file**

Run:

```bash
bun test test/session/relevance.test.ts
```

Expected: PASS.

**Step 4: Commit the helper**

```bash
git add packages/opencode/src/session/relevance.ts packages/opencode/test/session/relevance.test.ts
git commit -m "refactor: classify assistant handoff terminality"
```

### Task 4: Thread full-message terminality through batching and prompt selection

**Files:**

- Modify: `packages/opencode/src/session/queue-batch.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/subagent-send-continues.test.ts`
- Test: `packages/opencode/test/session/prompt-target-resolution.test.ts`
- Test: `packages/opencode/test/session/relevance.test.ts`

**Step 1: Update queue batching**

In `queue-batch.ts`, switch the answered check from the info-only helper to the new full-message helper so batching and FIFO use the same terminality rule as the loop.

**Step 2: Update prompt-side parked logic**

In `prompt.ts`, make `isParked(...)` and related pending-selection logic consult the same full-message classification instead of mixing `finish` checks with separate local heuristics.

**Step 3: Update the live processed-message path**

In the processor result path around the `attemptParts` read, build a temporary `MessageV2.WithParts` from `processor.message` plus `attemptParts`, then use the full-message helper for the `answered` decision.

This is the critical spot for the reproduced bug.

**Step 4: Run the focused integration tests**

Run:

```bash
bun test test/session/subagent-send-continues.test.ts test/session/prompt-target-resolution.test.ts test/session/relevance.test.ts
```

Expected:

- send-handoff regression: PASS
- parked-wait negative control: PASS
- unit spec file: PASS

**Step 5: Commit the fix**

```bash
git add packages/opencode/src/session/queue-batch.ts packages/opencode/src/session/prompt.ts packages/opencode/src/session/relevance.ts packages/opencode/test/session/subagent-send-continues.test.ts packages/opencode/test/session/prompt-target-resolution.test.ts packages/opencode/test/session/relevance.test.ts
git commit -m "fix: keep send-only agent handoffs non-terminal"
```

### Task 5: Guard the normal stop and wait behaviors

**Files:**

- Modify: `packages/opencode/test/session/subagent-send-continues.test.ts`
- Modify: `packages/opencode/test/session/processor-wait-stop.test.ts`
- Test: `packages/opencode/test/session/relevance.test.ts`

**Step 1: Add a normal terminal control**

Add or preserve a control test that proves a terminal assistant with no outgoing agent-message part still stops after one pass.

**Step 2: Add a wait control**

Extend `processor-wait-stop.test.ts` or a nearby wait-focused file so `wait_agent_message` with `status = "waiting"` still parks exactly as before. The send-handoff fix must not alter wait semantics.

**Step 3: Run the focused regression suite**

Run:

```bash
bun test test/session/subagent-send-continues.test.ts test/session/processor-wait-stop.test.ts test/session/prompt-target-resolution.test.ts test/session/relevance.test.ts
```

Expected: PASS.

**Step 4: Commit the regression guards**

```bash
git add packages/opencode/test/session/subagent-send-continues.test.ts packages/opencode/test/session/processor-wait-stop.test.ts packages/opencode/test/session/prompt-target-resolution.test.ts packages/opencode/test/session/relevance.test.ts
git commit -m "test: guard send handoff and wait terminality"
```

### Task 6: Verify the focused multi-agent suite before any wider cleanup

**Files:**

- Reference: `packages/opencode/test/session/message-routing-wake.test.ts`
- Reference: `packages/opencode/test/session/wait-since-lost-wake.test.ts`
- Reference: `packages/opencode/test/session/inbox-consumption-nonterminal.test.ts`

**Step 1: Run the focused end-to-end suite**

Run:

```bash
bun test test/session/subagent-send-continues.test.ts test/session/processor-wait-stop.test.ts test/session/prompt-target-resolution.test.ts test/session/relevance.test.ts test/session/message-routing-wake.test.ts test/session/wait-since-lost-wake.test.ts test/session/inbox-consumption-nonterminal.test.ts
```

Expected: PASS.

**Step 2: Do not fold secondary overflow/wait ideas into this fix**

Keep the pending-queue overflow hypothesis and any prompt-protocol wording cleanup out of this patch unless the focused suite disproves the chosen root cause. The goal of this change is only to fix terminal send-handoff classification.

**Step 3: Commit the verification checkpoint**

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/src/session/queue-batch.ts packages/opencode/src/session/relevance.ts packages/opencode/test/session/subagent-send-continues.test.ts packages/opencode/test/session/processor-wait-stop.test.ts packages/opencode/test/session/prompt-target-resolution.test.ts packages/opencode/test/session/relevance.test.ts
git commit -m "test: verify multi-agent send continuation fix"
```
