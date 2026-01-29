# Merge Fix Plan (Production)

Context: this repo is mid-merge (conflicts resolved, merge commit not created yet). The staged merge result currently fails `bun turbo typecheck` and has several confirmed safety/behavior regressions introduced by combining upstream `origin/dev` with our fork.

This document is the single source of truth for:
- what we are fixing
- why we are fixing it
- how we validate
- current status

Principles:
- Preserve fork invariants: real subagent sessions, explicit `send_agent_message`/`wait_agent_message` semantics, and Overcode UX constraints.
- Align API/schema/SDK types with actual server runtime behavior.
- Fix correctness first (typecheck/build), then safety, then UX/perf.
- Avoid wide churn; prefer minimal patches with tests.

## Current State

- Merge conflicts: resolved and staged.
- Merge commit: NOT created yet.
- Known new unstaged change from running build/test locally: `packages/opencode/src/provider/models-snapshot.ts` was regenerated (huge diff). Decide later whether to keep/stage it.

## Phase 0 - Baseline Guardrails

- [x] Confirm no unmerged files (`git ls-files -u` empty)
- [x] Confirm no conflict markers remain (`<<<<<<<`, `=======`, `>>>>>>>`)
- [x] Capture baseline failures (`bun turbo typecheck --continue`)

## Phase 1 - Unblock Typecheck (Critical)

### 1.1 Duplicate `addSandbox` implementation

Problem:
- `packages/opencode/src/project/project.ts` defines `addSandbox` twice (TS2393).

Plan:
- Remove duplicate export.
- Normalize paths consistently in add/remove (prefer `path.resolve`).

Validation:
- `bun turbo typecheck --filter overcode-ai`
- Run `packages/opencode` project tests.

- [x] Fix duplicate `addSandbox`

### 1.2 Plugin package imports missing SDK export (`Permission`)

Problem:
- `packages/plugin/src/index.ts` imports `Permission` from `@opencode-ai/sdk`, which does not export it (TS2305).

Plan:
- Import `PermissionRequest` from SDK.
- Export `type Permission = PermissionRequest` from the plugin package for backwards-compatible hook typing.

Validation:
- `bun turbo typecheck --filter @opencode-ai/plugin`

- [x] Fix plugin `Permission` type

### 1.3 Internal auth plugins using wrong client call shapes

Problem:
- `packages/opencode/src/plugin/codex.ts` and `packages/opencode/src/plugin/copilot.ts` use `{ path, body }` request shapes incompatible with the v2 client used by `packages/opencode/src/plugin/index.ts`.

Plan:
- Update codex auth writes to use `client.auth.set({ providerID, auth })`.
- Update copilot session fetch to use `client.session.get({ sessionID }, { throwOnError })`.
- Fix any `session.data` undefined handling.

Validation:
- `bun turbo typecheck --filter overcode-ai`
- Run relevant plugin tests.

- [x] Fix internal plugin client call shapes

### 1.4 Tool context now requires `messages`

Problem:
- `Tool.Context` now requires `messages`, but call sites/tests omit it (TS2741).

Plan:
- Fix production call site(s), notably compaction invalid tool execution.
- Add `messages: []` to test contexts (or central helper).

Validation:
- `bun turbo typecheck --filter overcode-ai`
- `bun test` in `packages/opencode`

- [x] Provide `messages` in all Tool.Context call sites + tests

### 1.5 `session/prompt.ts` tool part typing errors

Problem:
- ToolPart state union includes `pending` without `time`; code spreads `part.state.time`.
- ToolPart state expects `Record<string, any>` but code uses `unknown`.

Plan:
- Avoid spreading `part.state.time` unless narrowed; write `time` explicitly.
- Make tool args typed as record when stored in tool part state.

Validation:
- `bun turbo typecheck --filter overcode-ai`

- [x] Fix `ToolPart` state typing errors in prompt loop

### 1.6 App/Desktop permission settings type mismatch

Problem:
- App writes `config.permission` as an object map, but generated SDK types define `PermissionConfig` as string or tuple-array.

Plan:
- Align server OpenAPI schema + generated SDK so `config.permission` supports object map (the server runtime normalized representation).
- Regenerate OpenAPI + JS SDK.

Validation:
- `bun turbo typecheck --filter @opencode-ai/app --filter @opencode-ai/desktop`
- `packages/opencode/test/server/openapi.test.ts`

- [x] Fix PermissionConfig schema/type mismatch and regenerate SDK

## Phase 2 - Safety / Behavioral Fixes (High)

### 2.1 `apply_patch` treated as edit tool

Problem:
- `PermissionNext.disabled()` maps only `edit/write/patch/multiedit` to `edit`; missing `apply_patch`.

Plan:
- Add `apply_patch` to the edit-tool mapping.
- Update any legacy tool->permission mappings to include apply_patch.

Validation:
- Permission tests in `packages/opencode/test/permission`.

- [x] Map `apply_patch` under `edit` for tool disabling

### 2.2 `apply_patch` move destination missing from permission patterns

Plan:
- Include both source and destination paths in permission patterns for move operations.

- [x] Include move destination in `apply_patch` permission patterns

### 2.3 OpenAI session header consistency (`session_id`)

Plan:
- Ensure codex plugin does not override `session_id` inconsistently (either match `sess_...` or defer to LLM layer).
- Add a test that includes plugin hooks so this can’t regress.

- [x] Fix OpenAI/Codex session header consistency

### 2.4 App global event stream robustness

Plan:
- Move error handling inside the `while (true)` loop and add retry/backoff.

- [x] Make global event stream reconnect reliably

### 2.5 `server.heartbeat` missing from OpenAPI event union

Plan:
- Define/declare the event schema and regenerate OpenAPI/SDK.

- [x] Add `server.heartbeat` to event schema/OpenAPI

### 2.6 Worktree reset default branch fallback

Plan:
- Include `dev` in fallback list, or make fallback configurable/robust.

- [x] Fix worktree reset default branch fallback

### 2.7 Gate destructive worktree operations

Problem:
- Worktree reset/remove are destructive and were callable without explicit confirmation.

Plan:
- Add `confirm: true` (boolean flag) to reset/remove inputs and refuse to run without it.

Validation:
- Typecheck + SDK regen.

- [x] Require `confirm=true` for worktree reset/remove

### 2.8 Cache instruction URL fetches

Problem:
- Instruction URLs were fetched on every prompt build (latency + repeated failures).

Plan:
- Add a short TTL cache for URL fetch results.

- [x] Cache InstructionPrompt URL fetches (TTL)

## Phase 3 - Verification

- [x] `bun turbo typecheck` (all packages)
- [x] `bun test` in `packages/opencode`
- [x] Regenerate JS SDK if schema changed (`./packages/sdk/js/script/build.ts`)
- [ ] Decide what to do with regenerated `models-snapshot.ts` (keep/stage vs revert)

## Progress Log

- Started: 2026-01-28
- Updated: 2026-01-28 (typecheck+tests passing; safety fixes applied)
