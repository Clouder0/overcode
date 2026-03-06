# Queued Inbound Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make relevant inbound queued messages enter model and tool context at the next safe boundary, instead of being deferred behind a stale active processor attempt.

**Architecture:** Treat each active `processor.process()` call as operating on an immutable context snapshot. When relevant inbound arrives during that attempt, mark the attempt as stale and cooperatively return to the outer prompt loop at a safe boundary. The outer prompt loop remains the only place that drains pending messages, rebuilds `sessionMessages`, recomputes `waitContext`, resolves tools, and starts the next provider call.

**Tech Stack:** Bun, TypeScript, `ai` SDK `streamText`, session prompt loop, session processor, Bun test.

---

### Task 1: Lock the root-cause reproduction in tests

**Files:**

- Create: `packages/opencode/test/session/queued-inbound-refresh.test.ts`
- Reference: `packages/opencode/src/session/prompt.ts`
- Reference: `packages/opencode/src/session/processor.ts`

**Step 1: Write a failing processor-boundary test**

Add a test that:

- starts a real session loop
- mocks `LLM.stream()` / `SessionProcessor.create()` behavior so one attempt would otherwise make two tool decisions in sequence
- delivers a relevant inbound agent message after the first tool result while the session is still active
- asserts the active attempt stops before the second tool decision runs

**Step 2: Write a failing context-refresh test**

Add a second test that asserts the next prompt-loop attempt includes the newly queued inbound message in `input.messages` / tool context.

**Step 3: Run the focused test file to confirm failure**

Run:

```bash
bun test test/session/queued-inbound-refresh.test.ts
```

Expected: FAIL because the second tool decision still runs on stale context.

**Step 4: Commit the red test**

```bash
git add packages/opencode/test/session/queued-inbound-refresh.test.ts
git commit -m "test: reproduce stale queued inbound refresh"
```

### Task 2: Add explicit turn invalidation state in the prompt loop

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/queued-inbound-refresh.test.ts`

**Step 1: Add session-scoped invalidation state**

Add a new `Instance.state` map/set in `prompt.ts` for “active attempt became stale because relevant inbound arrived”. Keep it separate from `wakeAfter()` so wake scheduling and context invalidation are not conflated.

**Step 2: Add small helpers**

Add helpers with one job each:

- mark refresh requested for a session
- read whether refresh is requested
- clear refresh once the outer loop starts a fresh attempt

**Step 3: Mark refresh only for relevant inbound traffic**

In `SessionMessage.setWakeSessionFn(...)`, in the `state()[sessionID]` branch, mark refresh requested when the delivered message is the kind that should affect behavior on the next tool/model decision:

- incoming agent message
- `notice`
- `wait_result`
- human prompt

Do not mark refresh for outgoing parts or UI-only markers.

**Step 4: Run the focused test file**

Run:

```bash
bun test test/session/queued-inbound-refresh.test.ts
```

Expected: still FAIL, but now with invalidation state present and observable.

**Step 5: Commit**

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/session/queued-inbound-refresh.test.ts
git commit -m "refactor: track active-turn inbound invalidation"
```

### Task 3: Make the processor yield at safe boundaries when invalidated

**Files:**

- Modify: `packages/opencode/src/session/processor.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/queued-inbound-refresh.test.ts`
- Reference: `packages/opencode/test/session/processor-wait-stop.test.ts`

**Step 1: Thread an invalidation callback into processor input**

Extend the processor input path so `prompt.ts` can provide a tiny callback such as `shouldRefresh(): boolean`. Keep this as an orchestration concern; do not let tools or providers mutate shared state directly.

**Step 2: Stop only at safe boundaries**

In `processor.ts`, after these boundaries, check `shouldRefresh()`:

- after a normal `tool-result`
- after `finish-step`

If refresh is requested:

- stop the current stream cooperatively
- return control to the outer prompt loop
- do **not** try to mutate provider context in place

Do not interrupt in the middle of a running tool.

**Step 3: Preserve valid assistant state**

When yielding after a tool boundary, ensure the assistant message remains in a state the outer loop already understands for continuation. Reuse existing non-terminal semantics instead of inventing a second continuation mode unless a test proves the current shape is insufficient.

**Step 4: Run the focused test file**

Run:

```bash
bun test test/session/queued-inbound-refresh.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/opencode/src/session/processor.ts packages/opencode/src/session/prompt.ts packages/opencode/test/session/queued-inbound-refresh.test.ts
git commit -m "fix: refresh stale active turns after inbound messages"
```

### Task 4: Make the outer loop own all context rebuilding after invalidation

**Files:**

- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/queued-inbound-refresh.test.ts`
- Test: `packages/opencode/test/session/wait-since-lost-wake.test.ts`

**Step 1: Clear invalidation only when starting a fresh attempt**

Clear the refresh flag only after the outer loop has drained pending inbound, rebuilt `sessionMessages`, recomputed `waitContext`, and is about to launch a fresh processor attempt.

**Step 2: Avoid stale carry-over**

If an attempt yields because of invalidation, make sure the next iteration always re-enters through the existing pending-drain path before computing `tools`, `waitContext`, and `MessageV2.toModelMessages(...)`.

**Step 3: Add a regression assertion for `waitContext`**

Extend an existing wait-related test (or add one beside the new test) to prove a newly arrived inbound seq updates the next attempt’s `waitContext`, not just the persisted transcript.

**Step 4: Run the targeted tests**

Run:

```bash
bun test test/session/queued-inbound-refresh.test.ts test/session/wait-since-lost-wake.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/opencode/src/session/prompt.ts packages/opencode/test/session/queued-inbound-refresh.test.ts packages/opencode/test/session/wait-since-lost-wake.test.ts
git commit -m "test: cover queued inbound context rebuild"
```

### Task 5: Guard against regressions and document the invariant in tests

**Files:**

- Modify: `packages/opencode/test/session/processor-wait-stop.test.ts`
- Modify: `packages/opencode/test/session/message-routing-wake.test.ts`
- Modify: `packages/opencode/test/session/subagent-send-continues.test.ts`

**Step 1: Add a non-regression test for normal sends**

Verify that `send_agent_message` still does not implicitly end the loop when no inbound refresh has arrived.

**Step 2: Add a non-regression test for active-loop delivery**

Verify that active-loop delivery still uses the existing wake path, but now also produces a fresh-at-safe-boundary continuation when relevant inbound arrives.

**Step 3: Add a short invariant comment in the test names / assertions**

The invariant should be explicit:

```text
New external input never mutates a live provider call.
It invalidates the current attempt and is incorporated only after the outer prompt loop rebuilds context.
```

**Step 4: Run the full focused suite**

Run:

```bash
bun test test/session/queued-batch-context.test.ts test/session/queued-inbound-refresh.test.ts test/session/processor-wait-stop.test.ts test/session/message-routing-wake.test.ts test/session/subagent-send-continues.test.ts test/session/wait-since-lost-wake.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/opencode/test/session/processor-wait-stop.test.ts packages/opencode/test/session/message-routing-wake.test.ts packages/opencode/test/session/subagent-send-continues.test.ts packages/opencode/test/session/queued-inbound-refresh.test.ts packages/opencode/test/session/wait-since-lost-wake.test.ts
git commit -m "test: lock queued inbound refresh boundaries"
```

### Task 6: Optional follow-up cleanup after the root cause is fixed

**Files:**

- Modify: `packages/opencode/src/session/llm.ts`
- Modify: `packages/opencode/src/session/message-v2.ts`
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/llm.test.ts`
- Test: `packages/opencode/test/session/inbox-consumption-nonterminal.test.ts`

**Step 1: Revisit lower-priority prompt issues only after Task 1-5 are green**

Follow-up items:

- Codex dynamic system prompt priority
- consumed inbound message visibility after handling
- CPD preserving seq/control-plane structure

**Step 2: Keep these as separate commits**

Do not bundle them into the root-cause fix. They are real issues, but they are not the primary cause of queued inbound missing same-turn tool context.
