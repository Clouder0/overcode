# Fix Plan 2: Real-World Context-Length Reliability

Goal: make the CPD + tail pipeline behave correctly under real provider `context_length` failures (GPT-5.*), without poisoning the session state or losing critical context.

Problem report (from real usage)

- User hits the terminal error: `Context length errors persist after automatic context maintenance...`.
- After that, sending a new message can proceed, but conversation behavior is wrong (likely due to stale pending selection / missing context).

Confirmed issues (re-verified in code)

1) FIFO poison: a terminal `context_length` failure leaves the target user effectively “pending forever”

- Pending selection requires an “answered” assistant reply.
- `isAssistantAnswered()` currently rejects replies with `error`, and also requires `finish`.
- The `context_length` give-up path sets `error` + `time.completed` but does not set `finish`.

2) Retry clutter: `context_length` retries create extra empty assistant messages

- Each provider attempt creates a new assistant message.
- When the provider rejects at request time, the attempt message often has no parts and no finish.

3) Recovery doesn’t converge: forced maintenance can cut too little, then we give up too early

- Forced maintenance uses a small minimum drop when estimates undercount.
- Provider errors often include exact max/requested tokens, but we do not use that signal.

4) Tool-derived facts can be lost during CPD update when outputs are trimmed

- Tool outputs are trimmed (placeholder) before CPD update.
- The CPD delta builder currently uses placeholder output when compacted, so the CPD model never sees even an excerpt.

5) (Correctness) data:text/plain decode uses wrong input and corrupts content

- `createUserMessage()` decodes `data:` text/plain by calling `Buffer.from(part.url, "base64url")`, where `part.url` is the full data URL.
- This yields garbage prefixes and can corrupt the inlined text.

Implementation plan (order matters)

Phase A: Prevent session poisoning (high priority)

- [x] Update `isAssistantAnswered()` so a completed assistant error (non-summary) counts as answered.
- [x] Set `finish = "error"` on terminal assistant error messages created by SessionPrompt loop paths:
  - preflight failure (overflow)
  - forced maintenance failure
  - `context_length` give-up

Phase B: Reduce retry clutter

- [x] When retrying after a `context_length` provider rejection, delete the attempt assistant message if it has zero parts.
  - Keep the terminal error message so the user sees the failure.

Phase C: Make `context_length` recovery converge

- [x] Parse provider error message/responseBody to extract max/requested/overage when possible.
- [x] Thread a `minDrop` signal into `applyMaintenance()` and use it to set `excess` (max with estimator-based excess).
- [x] Scale `minDrop` by attempt when parsing fails (bounded fallback) so later retries cut more.
- [x] Improve the terminal error to include the provider’s context-length message (capped).

Phase D: Preserve tool-derived facts in CPD updates

- [x] In CPD delta formatting, include a bounded excerpt of tool output even when `time.compacted` is set.
- [x] Apply the same bounded tool output rule to manual `/summarize` (server route).

Phase E: Fix data URL text decoding

- [x] Correctly parse `data:*;base64,...` and decode only the payload with base64.

Verification

- [x] Add/adjust tests:
  - completed-error assistant counts as answered (FIFO advances)
  - retry attempt message with zero parts is deleted
  - CPD delta includes tool output excerpt even when compacted
  - data:text/plain decode yields correct text
  - (overage parsing is covered indirectly via context_length retry tests)
- [x] Run `bun test` and `bun run typecheck`.

Progress log

- 2026-01-28: Plan written.
- 2026-01-28: Implemented FIFO terminal-error semantics, context_length retry cleanup, minDrop signal, CPD tool output excerpts, and data URL decoding fix.
- 2026-01-28: Added tests and verified `bun test` + `bun run typecheck`.
