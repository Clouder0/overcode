# Compaction / Context Management Redesign (CPD + Tail)

This document proposes a production-grade redesign of opencode session compaction.
It focuses on long-reasoning models (native thinking) and a TUI-first user experience.

## Progress

Use this checklist to track implementation status.

- [ ] Phase 0: Feature flags + scaffolding
- [ ] Phase 1: CPD storage + injection
- [ ] Phase 2: FIFO Target User selection
- [ ] Phase 3: Budget-driven tool output trimming (pre-flight)
- [ ] Phase 4: CPD update model call (tail-in / prefix-out) + reasoning rejection fallback
- [ ] Phase 5: Tail reasoning truncation (assistant-step unit) + persistent banner
- [ ] Phase 6: Manual `/compact` mapped to CPD update (no auto-continue)
- [ ] Phase 7: Retire old auto-compaction replay flow / compaction request artifacts
- [ ] TUI: Header badges + toasts + transcript markers + `/context` dialog
- [ ] Tests: Session + provider rejection + TUI acceptance pass

## Goals

- Keep the agent running continuously in long sessions without losing critical context.
- Preserve native reasoning in the active working window (the "tail") whenever possible.
- Reduce context load deterministically when near/exceeding model limits.
- Avoid replaying/duplicating user prompts and avoid injecting misleading "compaction request" user text.
- Make degradation visible and explainable to the user (TUI) and to the model.
- Be robust to provider constraints (e.g., OpenAI reasoning context rejection).

## Non-Goals

- Perfect token counting across all providers (we will use conservative estimates + retries).
- Preserving unlimited native reasoning history (we explicitly truncate older reasoning when required).
- Changing tool semantics or how tools work (only trimming tool *outputs* to reduce context).

## Current Issues (Summary)

The current compaction system is message/task-driven and introduces several correctness and UX issues:

- Compaction creates a user message whose model content becomes "What did we do so far?".
- Auto-compaction can trigger before processing the newest user input.
- Auto-compaction may synthesize a replay user message (re-sending partial/queued user text).
- Compaction strips assistant reasoning from its own input.
- After compaction, history is cut at the compaction request boundary, so reasoning disappears from model context.

These combine into "lost thinking" + "wrong prompt replay" failures for long-reasoning models.

## Terminology

### Target User (FIFO)

The user message we are about to answer next.

We process queued user messages in FIFO order for predictability and to match the TUI "QUEUED" UI.

### Prefix vs Tail

- Tail: all messages from Target User onward. Tail may include many assistant steps and many tool calls/results.
- Prefix: all messages before Tail.

In implementation we use a "summary + window" pattern:

- CPD summarizes history up to `cpd.uptoMessageID`.
- The uncompacted window is all messages with `id > cpd.uptoMessageID`.
- Tail is a subset of that window (starting at Target User).

### Assistant Step (Truncation Unit)

Within one assistant message, the AI SDK emits `start-step`/`finish-step` events.
opencode persists these as parts:

- `step-start`
- `step-finish`

One "assistant step" is the ordered sequence of parts between one `step-start` and its matching `step-finish`.
This is the unit we use when truncating reasoning: drop reasoning from older steps first.

### CPD (Compacted Prefix Digest)

CPD is a session-level, bounded, structured digest of all Prefix content.

CPD is *not* a chat message.
It is injected into prompts as a system-style block.

CPD is authoritative for earlier context: once prefix is compacted, the model should not expect the full prefix.

## Core Architecture

We replace "compaction as a message/task" with "compaction as prompt-fit pipeline".

There are two model calls with different contracts:

1. Continuation call (main agent call)
2. CPD update call (prefix compaction call)

### Continuation Call Contract

Purpose: continue the conversation and produce the next assistant response.

Prompt shape:

1. System prompt(s)
2. CPD block (if present)
3. Context Integrity Banner (always present)
4. Uncompacted window messages verbatim (including native reasoning unless truncated)

Guarantee:

- The uncompacted window is preserved verbatim (including native reasoning parts) unless we hit the tail-too-large fallback.

### CPD Update Call Contract (Prefix Compaction)

Purpose: update CPD so that Prefix remains useful but bounded.

Key rule: "tail-in / prefix-out"

- The CPD updater must see the current state (tail snapshot) to know what prefix details matter.
- The CPD updater must only output CPD (no tail, no chain-of-thought).

## Prompt-Fit Pipeline (Algorithm)

This pipeline runs before every continuation call.

### Step 0: Select Target User (FIFO)

- Choose the earliest un-answered user message (first queued).
- Define Tail = messages from Target User onward.
- Define Prefix = messages before Tail.
- Define uncompacted window = messages with `id > cpd.uptoMessageID` (or all messages if no CPD yet).

### Step 1: Build candidate continuation prompt

Candidate = `system + CPD + banner + uncompacted window`.

Check fit against usable input budget.

Notes:

- Use conservative estimation with a margin (e.g., reserve output tokens and keep prompt <= 90% of input budget).
- If provider returns context-length error anyway, treat it as an immediate "over budget" signal and run the pipeline.

### Step 2: Trim tool outputs (first lever)

If candidate prompt is too large:

- Trim tool *outputs* only (not tool calls, not tool inputs).
- Prefer trimming oldest outputs in Prefix first.
- If still too large, trim tool outputs in Tail.

Trimming means:

- Replace the tool output payload in model context with a placeholder.
- Preserve enough metadata for the user to inspect that trimming occurred.

This step sets a sticky session flag: `toolOutputsTrimmed=true`.

Rebuild candidate prompt and re-check.

### Step 3: Update CPD (prefix compaction)

If still too large:

- Update CPD using a dedicated compaction model call.
- CPD update input includes:

  1) Tail Snapshot (conditioning) including the *latest native thinking* (latest assistant step reasoning)
  2) Existing CPD (if any)
  3) Prefix Delta (only messages not yet included in CPD)

Rebuild candidate prompt (`system + CPD + banner + Tail`) and re-check.

### Step 4: Truncate native reasoning in Tail (rare, last resort)

If prompt still does not fit, the tail dominates.
Prefix compaction cannot help anymore.

Policy:

- Truncate reasoning by assistant steps, oldest-first.
- Keep newest step reasoning intact if possible.

Set sticky session flag: `reasoningTruncated=true` and record counts.

Rebuild candidate prompt and re-check.

### Step 5: Hard fail (exceptional)

If prompt still does not fit after:

- tool output trimming
- CPD update
- reasoning truncation

Then the target user message itself is too large or the provider/system overhead is too large.

Hard fail with clear user action:

- Suggest splitting the prompt.
- Suggest selecting a larger-context model.
- Suggest reducing thinking effort (if supported).

## Tail Snapshot (CPD Update Input)

We include the latest native thinking to let the compaction model understand current state.

Tail Snapshot content (bounded):

- Target user request text.
- Recent tool state digest (tool names + short outcomes).
- Latest native thinking: reasoning parts from the newest assistant step only.
- Sticky flags and summary of degradations:
  - tool outputs trimmed?
  - reasoning truncated?
  - provider rejected reasoning context?

The Tail Snapshot is marked as "read-only conditioning" in the compaction prompt:

- Do not summarize it.
- Do not copy it verbatim into CPD.
- Use it to decide what prefix information should be preserved.

## CPD Content Format (Structured)

CPD must be explicit, stable, and bounded.

Recommended sections:

- Current objective (durable goal)
- Constraints and preferences
- Decisions (and rationale)
- Files/components touched
- Tool-derived facts (high-level)
- Current progress
- Next steps
- Open questions / risks

CPD must have a strict size budget.
If CPD grows, re-compress CPD itself rather than re-summarizing the entire prefix.

## Provider Handling (Native Thinking + Fallback)

We attempt to include the latest native thinking in the CPD update call.
Providers may reject reasoning context (notably OpenAI with store=false flows).

If the provider rejects reasoning context:

- Retry the CPD update call without reasoning parts.
- Set sticky flag: `providerRejectedReasoningContext=true`.
- Keep native reasoning visible to the user (TUI), but mark it as "not sent" to the provider.
- The Context Integrity Banner (model-visible) must reflect the degradation.

## UX (TUI-First)

The user must always understand:

- when context maintenance is happening
- what was trimmed/compacted
- when behavior degraded (reasoning truncated, provider rejected reasoning context)

### At-a-glance indicators (Header)

The session header already displays context % based on last assistant tokens.
We extend it with compact indicators:

- CPD: prefix digest enabled
- TRIM: tool outputs trimmed at least once
- THINK: reasoning truncated at least once
- RCTX: provider rejected reasoning context at least once
- CMP: currently compacting

These are small, color-coded badges.

### Status / toasts

Use toasts (rate-limited) for operational transparency:

- Info: "Updated CPD" / "Trimmed tool outputs (N)"
- Warning: "Truncated older reasoning steps (N)" (always)
- Warning: "Provider rejected reasoning context; continuing without older native thinking" (always)
- Error: "Cannot fit context; action required" (always)

### Transcript markers (auditability)

When a material change happens (TRIM/THINK/RCTX), add a small, non-intrusive marker in the transcript.

The marker should be expandable (dialog) to show details:

- what changed
- when
- counts and estimated token impact

### `/context` dialog (inspectability)

Add a TUI command/dialog to inspect current context state:

- CPD text (scrollable)
- CPD metadata (updatedAt, approx size)
- flags: CPD/TRIM/THINK/RCTX
- last actions: how many tool outputs trimmed, how many steps truncated
- a short "what the model sees" summary: system + CPD + banner + tail (token estimate)

This makes the system debuggable and reduces "magic".

### Model-visible Context Integrity Banner

Always include a small system reminder in the continuation prompt.
It becomes more explicit when degradations occur.

Base banner (always):

- Tool outputs may be trimmed to fit context.
- Use CPD + visible messages.
- Ask to rerun tools if details are needed.

If THINK/RCTX flags are set, append:

- Older reasoning steps were omitted due to context limits.
- Provider rejected prior reasoning context; older native thinking may be unavailable.

This banner should be short and stable (so it does not become a new source of overflow).

## Manual vs Auto

### Auto

- Pipeline runs automatically.
- After CPD update, proceed with the same Target User message.
- Never synthesize a replay user message.

### Manual `/compact`

- Update CPD (prefix digest) and stop.
- Show CPD update result in TUI (toast + marker).
- Do not auto-continue into answering the next prompt.

## Implementation Plan (Phased, Test-Driven)

This plan prioritizes safety and observability.

### Phase 0: Feature flags + scaffolding

- Add config flag (e.g., `experimental.context_pipeline=true`).
- Keep existing compaction behavior as default until new pipeline is stable.

### Phase 1: CPD storage + injection

- Add CPD storage in session state (Storage key per session).
- Add CPD injection into prompt building (continuation call).
- Add TUI `/context` dialog that can display CPD (even before auto updates exist).

Tests:

- Unit: CPD load/store roundtrip.
- Integration: prompt contains CPD block when present.

### Phase 2: FIFO Target User selection

- Update session loop to select earliest queued user message.
- Ensure TUI "QUEUED" behavior matches processing order.

Tests:

- Integration: when two user messages are queued, the earlier one is answered first.

### Phase 3: Budget-driven tool output trimming (pre-flight)

- Implement token estimation for prompt candidate.
- Add trimming pass (Prefix first, then Tail) until within budget.
- Record TRIM state and surface to TUI.

Tests:

- Unit: trimming reduces estimated tokens; trimming order is oldest-first.
- Integration: continuation call fits after trimming.

### Phase 4: CPD update model call (tail-in / prefix-out)

- Implement incremental CPD update (Prefix Delta only).
- Tail Snapshot includes latest assistant step reasoning (native).
- Provider rejection fallback: retry without reasoning and set RCTX.

Tests:

- Integration: CPD update triggers when needed and reduces prompt size.
- Regression: "direction change" queued message does not get replayed.
- Provider simulation: reasoning rejection sets RCTX + continues.

### Phase 5: Tail reasoning truncation (THINK) + persistent banner

- Implement assistant-step-based reasoning truncation.
- Persist THINK state.
- Update model-visible banner accordingly.
- Add TUI warning toast + transcript marker.

Tests:

- Integration: if tail too big, older step reasoning is removed first.
- Integration: model receives banner when THINK set.

### Phase 6: Manual `/compact` mapped to CPD update

- Change manual compact to update CPD and stop.
- Keep audit markers and `/context` inspection.

Tests:

- Integration: manual compact does not auto-continue.

### Phase 7: Remove/retire old auto-compaction replay flow

- Remove synthetic replay logic from auto compaction.
- Remove compaction request user message artifacts in auto mode.
- Keep compatibility for existing sessions.

## Testing Strategy

### Session-level automated tests

- FIFO queue ordering.
- Tool output trimming order and placeholders.
- CPD update correctness:
  - only compress prefix delta
  - tail remains verbatim
  - latest thinking included in CPD update input
- Tail-too-large reasoning truncation:
  - step-based truncation
  - THINK flag set
  - banner injected
- Provider rejection path:
  - retry without reasoning
  - RCTX flag set
  - banner injected

### TUI acceptance checklist (manual)

- Header badges reflect CPD/TRIM/THINK/RCTX and current CMP.
- Toasts appear for TRIM/THINK/RCTX with correct severity.
- `/context` shows CPD text, flags, and counts.
- When reasoning is truncated, user can tell immediately and model keeps continuing coherently.

## Observability

Emit structured events (log + bus) for:

- CPD updated (size, delta size)
- tool outputs trimmed (count, estimated tokens freed)
- reasoning truncated (steps dropped, estimated tokens freed)
- provider rejected reasoning context (provider/model)
- hard fail due to context

This makes regressions and provider-specific issues diagnosable.
