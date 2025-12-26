# Implementation Plan: Message-Based Communication System

## Executive Summary

This document outlines a historical plan to migrate from the existing job-based subagent system to a unified message-based communication protocol.

## Status (historical)

The plan in this document was based on an XML-tag protocol (`<message>` / `<wait>`) and references many file paths that have since moved. The current runtime implementation uses tool-based messaging:

- `send_message({ to: "ses_..." | "caller", text: "..." })`
- `wait_message({ sources: ["ses_..."], timeout: 60000, mode: "all" | "any" })` (explicit session IDs only, `timeout > 0`)

Treat the remainder of this document as historical context. For current behavior, see:

- `packages/opencode/src/tool/send-message.ts`
- `packages/opencode/src/tool/wait-message.ts`
- `packages/opencode/src/session/message-routing.ts`
- `packages/opencode/src/session/wait-policy.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/system.ts`

## Current State Analysis

### Existing Job System Components

| File                              | Purpose                         | Lines | Action  |
| --------------------------------- | ------------------------------- | ----- | ------- |
| `src/job/index.ts`                | Core job lifecycle, concurrency | ~400  | Remove  |
| `src/job/registry.ts`             | Job type definitions            | ~70   | Remove  |
| `src/job/context.ts`              | Job execution context           | ~230  | Remove  |
| `src/job/stream.ts`               | Frame-based I/O                 | ~180  | Remove  |
| `src/job/notification.ts`         | Push notifications              | ~160  | Adapt   |
| `src/job/definitions/subagent.ts` | Subagent job implementation     | ~200  | Replace |
| `src/tool/job.ts`                 | Generic job tools               | ~550  | Remove  |
| `src/tool/job-generator.ts`       | Auto-generate job tools         | ~230  | Remove  |
| `src/tool/job-bridge.ts`          | Bridge tools for workers        | ~80   | Remove  |
| `src/server/job.ts`               | Job server endpoints            | ~100  | Adapt   |

**Total to remove/replace: ~2,200 lines**

### Dependencies on Job System

- `src/session/prompt.ts`: JobNotification.init(), hasPending(), drain()
- `src/session/system.ts`: SystemPrompt.jobs()
- `src/tool/registry.ts`: Job tool registration
- `src/server/index.ts`: Job server routes

## New System Components

### New Files to Create

| File                             | Purpose                           | Estimated Lines |
| -------------------------------- | --------------------------------- | --------------- |
| `src/session/message-routing.ts` | Cross-session message delivery    | ~300            |
| `src/session/message-wait.ts`    | Wait state and timeout management | ~200            |
| `src/session/message-parser.ts`  | XML message parsing               | ~150            |
| `src/tool/subagent-spawn.ts`     | Subagent creation tool            | ~100            |
| `src/tool/session-close.ts`      | Session close tool (optional)     | ~50             |

**Total new code: ~800 lines**

### Files to Modify

| File                        | Changes                            |
| --------------------------- | ---------------------------------- |
| `src/session/prompt.ts`     | Add message parsing, wait handling |
| `src/session/index.ts`      | Add caller tracking, session type  |
| `src/session/message-v2.ts` | Add AgentMessagePart type          |
| `src/session/system.ts`     | Update system prompts              |
| `src/tool/registry.ts`      | Register new tools                 |
| `src/agent/agent.ts`        | Add structured output config       |

## Implementation Phases

### Phase 1: Foundation (Week 1)

#### 1.1 Message Types and Storage

**File: `src/session/message-v2.ts`**

Add new part type (IMPLEMENTED):

```typescript
// Note: In the actual implementation, this is named MessagePart with type "message"
export const MessagePart = PartBase.extend({
  type: z.literal("message"),
  direction: z.enum(["outgoing", "incoming"]),
  peer: z.string(),
  peerType: z.enum(["human", "agent"]),
  text: z.string(),
  timeout: z.number().optional(),
  timeoutOccurred: z.boolean().optional(),
  time: z.object({
    created: z.number(),
  }),
}).meta({
  ref: "MessagePart",
})
```

**Tasks:**

- [x] Add MessagePart schema to MessageV2
- [x] Update Part union type
- [x] Add to toModelMessage() serialization
- [x] Write unit tests for new part type

#### 1.2 Session Model Updates

**File: `src/session/index.ts`**

Add session relationship tracking:

```typescript
interface SessionInfo {
  // ... existing fields ...
  type: "primary" | "subagent"
  caller?: string // Parent session ID
  children: string[] // Child session IDs
}
```

**Tasks:**

- [ ] Add type, caller, children fields to Session.Info
- [ ] Update Session.create() to accept caller parameter
- [ ] Add Session.getChildren() helper
- [ ] Update Session.close() to close children
- [ ] Write unit tests

#### 1.3 Message Parser

**File: `src/session/message-parser.ts`**

```typescript
export namespace MessageParser {
  interface ParsedMessage {
    to: string
    timeout: number
    content: string
  }

  interface ParsedWait {
    sources: string[]
    timeout: number
    mode: "all" | "any"
  }

  interface ParseResult {
    messages: ParsedMessage[]
    wait?: ParsedWait
    remainingText: string
  }

  export function parse(output: string): ParseResult
  export function serialize(message: ParsedMessage): string
}
```

**Tasks:**

- [ ] Implement XML parsing for `<message>` elements
- [ ] Implement `<wait>` element parsing
- [ ] Handle malformed XML gracefully
- [ ] Extract non-message text content
- [ ] Write comprehensive unit tests

### Phase 2: Message Routing (Week 2)

#### 2.1 Message Routing Core

**File: `src/session/message-routing.ts`**

```typescript
export namespace SessionMessage {
  interface Message {
    id: string
    from: string
    to: string
    text: string
    time: number
    type?: "normal" | "timeout" | "error"
  }

  // Deliver message to target session
  export async function deliver(message: Omit<Message, "id" | "time">): Promise<Message>

  // Get pending messages for a session
  export async function pending(sessionID: string): Promise<Message[]>

  // Resolve target ("caller", "human", or session ID)
  export function resolveTarget(to: string, fromSession: string): string

  // Subscribe to messages for a session
  export function subscribe(sessionID: string, callback: (message: Message) => void): () => void
}
```

**Tasks:**

- [ ] Implement message delivery with storage
- [ ] Implement target resolution (caller, human, session ID)
- [ ] Implement pending message retrieval
- [ ] Implement subscription mechanism
- [ ] Handle "human" target specially (no storage, direct to UI)
- [ ] Write unit tests

#### 2.2 Wait State Management

**File: `src/session/message-wait.ts`**

```typescript
export namespace MessageWait {
  interface WaitState {
    sessionID: string
    sources: string[]
    timeout: number
    mode: "all" | "any"
    received: Map<string, string>
    timer?: Timer
  }

  // Register a wait for single source
  export function registerSingle(sessionID: string, source: string, timeout: number): void

  // Register a wait for multiple sources
  export function registerMulti(sessionID: string, sources: string[], timeout: number, mode: "all" | "any"): void

  // Check if session is waiting
  export function isWaiting(sessionID: string): boolean

  // Handle incoming message (may resolve wait)
  export function onMessage(sessionID: string, from: string, text: string): boolean // Returns true if wait was resolved

  // Cancel wait and cleanup
  export function cancel(sessionID: string): void
}
```

**Tasks:**

- [ ] Implement single-source wait registration
- [ ] Implement multi-source wait registration
- [ ] Implement timeout handling with Timer
- [ ] Implement wait resolution logic
- [ ] Inject timeout messages when timeout fires
- [ ] Write unit tests

### Phase 3: Prompt Loop Integration (Week 3)

#### 3.1 Session Prompt Updates

**File: `src/session/prompt.ts`**

Modify the prompt loop to handle message protocol:

```typescript
export const loop = fn(Identifier.schema("session"), async (sessionID) => {
  // ... existing setup ...

  while (true) {
    // NEW: Check for incoming messages
    const incoming = await SessionMessage.pending(sessionID)
    if (incoming.length > 0) {
      for (const msg of incoming) {
        await injectIncomingMessage(sessionID, msg)
      }
    }

    // ... existing turn processing ...

    // NEW: After turn, parse structured output
    const output = getAssistantResponse(result)
    const parsed = MessageParser.parse(output)

    if (parsed.messages.length > 0) {
      await processMessages(sessionID, parsed)
    } else {
      // Fallback: treat as plain text to human
      await processPlainResponse(sessionID, output)
    }
  }
})

async function processMessages(sessionID: string, parsed: ParseResult) {
  // Deliver all messages
  for (const msg of parsed.messages) {
    const target = SessionMessage.resolveTarget(msg.to, sessionID)
    await SessionMessage.deliver({
      from: sessionID,
      to: target,
      text: msg.content,
    })
  }

  // Handle wait behavior
  if (parsed.wait) {
    MessageWait.registerMulti(sessionID, parsed.wait.sources, parsed.wait.timeout, parsed.wait.mode)
  } else {
    const waitMsg = parsed.messages.find((m) => m.timeout !== 0)
    if (!waitMsg) {
      // All timeout=0: continue
      await injectContinue(sessionID)
      return loop(sessionID)
    } else if (waitMsg.timeout === -1) {
      // Infinite wait
      return // Exit loop, wait for message
    } else {
      // Timed wait
      MessageWait.registerSingle(sessionID, waitMsg.to, waitMsg.timeout)
    }
  }
}
```

**Tasks:**

- [ ] Add incoming message check at turn start
- [ ] Add structured output parsing after turn
- [ ] Implement message delivery flow
- [ ] Implement wait registration based on timeout values
- [ ] Handle timeout=0 (continue) case
- [ ] Handle fallback for non-structured output
- [ ] Write integration tests

#### 3.2 Incoming Message Injection

**Tasks:**

- [ ] Define incoming message format: `[From SOURCE]:\nCONTENT`
- [ ] Create injectIncomingMessage() function
- [ ] Handle timeout messages specially
- [ ] Store as AgentMessagePart
- [ ] Write tests

### Phase 4: Tools (Week 4)

#### 4.1 Subagent Spawn Tool

**File: `src/tool/subagent-spawn.ts`**

```typescript
export const SubagentSpawnTool = Tool.define("subagent_spawn", {
  description: "Create a new subagent session",

  parameters: z.object({
    agent: z.string().describe("Agent type: explore, librarian, etc."),
  }),

  async execute(params, ctx) {
    const agent = await Agent.get(params.agent)
    if (!agent) {
      return { output: `Unknown agent: ${params.agent}` }
    }
    if (agent.mode === "primary") {
      return { output: `Cannot spawn primary agent as subagent: ${params.agent}` }
    }

    const session = await Session.create({
      type: "subagent",
      agent: params.agent,
      caller: ctx.sessionID,
      parentID: ctx.sessionID,
    })

    // Add session to parent's children list
    await Session.addChild(ctx.sessionID, session.id)

    return {
      output: JSON.stringify({ session_id: session.id }),
      metadata: { session_id: session.id },
    }
  },
})
```

**Tasks:**

- [ ] Implement subagent_spawn tool
- [ ] Validate agent exists and is not primary
- [ ] Create session with caller tracking
- [ ] Update parent's children list
- [ ] Register tool in registry
- [ ] Write unit tests

#### 4.2 Session Close Tool

**File: `src/tool/session-close.ts`**

```typescript
export const SessionCloseTool = Tool.define("session_close", {
  description: "Close a subagent session",

  parameters: z.object({
    session_id: z.string().describe("Session ID to close"),
  }),

  async execute(params, ctx) {
    const session = await Session.get(params.session_id)
    if (!session) {
      return { output: `Session not found: ${params.session_id}` }
    }

    // Verify caller owns this session
    if (session.caller !== ctx.sessionID) {
      return { output: `Cannot close session not owned by caller` }
    }

    await Session.close(params.session_id)

    return { output: JSON.stringify({ closed: true }) }
  },
})
```

**Tasks:**

- [ ] Implement session_close tool
- [ ] Verify ownership before closing
- [ ] Close child sessions recursively
- [ ] Cancel any pending waits
- [ ] Register tool in registry
- [ ] Write unit tests

### Phase 5: System Prompts (Week 5)

#### 5.1 Update System Prompts

**File: `src/session/system.ts`**

Add message protocol instructions:

```typescript
export function messageProtocol(sessionType: "primary" | "subagent", caller?: string): string {
  if (sessionType === "primary") {
    return `
## Communication Protocol

Wrap responses in message tags:

<message to="human" timeout="-1">
Your response
</message>

Timeout values:
- timeout="-1": Wait for response
- timeout="0": Send and continue
- timeout="N": Wait N milliseconds

For subagents:
1. <tool:subagent_spawn agent="explore"/>
2. <message to="ses_xxx" timeout="120000">Task</message>
3. Response: [From ses_xxx]: ...
`
  } else {
    return `
## Session Context

You are a subagent.
Session: ${sessionID}
Caller: ${caller}

## Communication Protocol

<message to="caller" timeout="TIMEOUT">
Response
</message>

Patterns:
- Progress: timeout="0"
- Question: timeout="30000" 
- Final: timeout="-1"
- To human: to="human"
`
  }
}
```

**Tasks:**

- [ ] Add messageProtocol() function
- [ ] Integrate into system prompt building
- [ ] Include session context for subagents
- [ ] Remove old job-related prompts
- [ ] Test prompt generation

### Phase 6: Migration & Cleanup (Week 6)

#### 6.1 Feature Flag

Add feature flag for gradual rollout:

```typescript
// In src/flag/flag.ts
export const OPENCODE_USE_MESSAGE_PROTOCOL = process.env.OPENCODE_USE_MESSAGE_PROTOCOL === "true"
```

**Tasks:**

- [ ] Add feature flag
- [ ] Gate new code paths behind flag
- [ ] Allow runtime switching if possible

#### 6.2 Remove Job System

Once new system is verified:

**Files to delete:**

- [ ] `src/job/index.ts`
- [ ] `src/job/registry.ts`
- [ ] `src/job/context.ts`
- [ ] `src/job/stream.ts`
- [ ] `src/job/notification.ts`
- [ ] `src/job/definitions/subagent.ts`
- [ ] `src/tool/job.ts`
- [ ] `src/tool/job-generator.ts`
- [ ] `src/tool/job-bridge.ts`

**References to remove:**

- [ ] Job imports in `src/session/prompt.ts`
- [ ] Job system prompt in `src/session/system.ts`
- [ ] Job tools registration in `src/tool/registry.ts`
- [ ] Job server routes in `src/server/job.ts`

#### 6.3 Update Documentation

- [ ] Update AGENTS.md files
- [ ] Update any user-facing documentation
- [ ] Update API documentation if applicable

## Testing Strategy

### Unit Tests

| Component         | Test File                              | Coverage Target |
| ----------------- | -------------------------------------- | --------------- |
| MessageParser     | `test/session/message-parser.test.ts`  | 95%             |
| SessionMessage    | `test/session/message-routing.test.ts` | 90%             |
| MessageWait       | `test/session/message-wait.test.ts`    | 90%             |
| SubagentSpawnTool | `test/tool/subagent-spawn.test.ts`     | 90%             |
| AgentMessagePart  | `test/session/message-v2.test.ts`      | 85%             |

### Integration Tests

| Scenario                 | Test File                                    |
| ------------------------ | -------------------------------------------- |
| Simple subagent task     | `test/integration/subagent-simple.test.ts`   |
| Subagent with progress   | `test/integration/subagent-progress.test.ts` |
| Subagent question/answer | `test/integration/subagent-question.test.ts` |
| Parallel fan-out         | `test/integration/subagent-parallel.test.ts` |
| Nested subagents         | `test/integration/subagent-nested.test.ts`   |
| Timeout handling         | `test/integration/timeout.test.ts`           |
| Human interaction        | `test/integration/human-interaction.test.ts` |

### Test Cases

#### Message Parser Tests

```typescript
describe("MessageParser", () => {
  it("parses single message", () => {
    const input = `<message to="human" timeout="-1">Hello</message>`
    const result = MessageParser.parse(input)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].to).toBe("human")
    expect(result.messages[0].timeout).toBe(-1)
    expect(result.messages[0].content).toBe("Hello")
  })

  it("parses multiple messages", () => {
    const input = `
      <message to="ses_a" timeout="0">Task A</message>
      <message to="ses_b" timeout="0">Task B</message>
      <wait sources="ses_a,ses_b" timeout="60000" mode="all"/>
    `
    const result = MessageParser.parse(input)
    expect(result.messages).toHaveLength(2)
    expect(result.wait?.sources).toEqual(["ses_a", "ses_b"])
  })

  it("handles malformed XML gracefully", () => {
    const input = `<message to="human">No closing tag`
    const result = MessageParser.parse(input)
    // Should not throw, return empty or best-effort parse
  })

  it("extracts remaining text", () => {
    const input = `
      Some thinking here
      <message to="human" timeout="-1">Response</message>
      More text
    `
    const result = MessageParser.parse(input)
    expect(result.remainingText).toContain("Some thinking")
  })
})
```

#### Wait State Tests

```typescript
describe("MessageWait", () => {
  it("resolves single wait on message", async () => {
    MessageWait.registerSingle("ses_a", "ses_b", 30000)
    expect(MessageWait.isWaiting("ses_a")).toBe(true)

    const resolved = MessageWait.onMessage("ses_a", "ses_b", "Response")
    expect(resolved).toBe(true)
    expect(MessageWait.isWaiting("ses_a")).toBe(false)
  })

  it("fires timeout after duration", async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()

    MessageWait.registerSingle("ses_a", "ses_b", 1000, onTimeout)

    vi.advanceTimersByTime(1000)

    expect(onTimeout).toHaveBeenCalled()
  })

  it("resolves multi-wait in all mode", () => {
    MessageWait.registerMulti("ses_a", ["ses_b", "ses_c"], 60000, "all")

    MessageWait.onMessage("ses_a", "ses_b", "Response B")
    expect(MessageWait.isWaiting("ses_a")).toBe(true) // Still waiting for ses_c

    MessageWait.onMessage("ses_a", "ses_c", "Response C")
    expect(MessageWait.isWaiting("ses_a")).toBe(false) // Done
  })

  it("resolves multi-wait in any mode on first", () => {
    MessageWait.registerMulti("ses_a", ["ses_b", "ses_c"], 60000, "any")

    MessageWait.onMessage("ses_a", "ses_b", "Response B")
    expect(MessageWait.isWaiting("ses_a")).toBe(false) // Done on first
  })
})
```

#### Integration Tests

```typescript
describe("Subagent Integration", () => {
  it("completes simple subagent task", async () => {
    const session = await Session.create({ type: "primary" })

    // Simulate: spawn subagent, send task, get result
    await SessionPrompt.prompt({
      sessionID: session.id,
      parts: [{ type: "text", text: "Find auth implementation" }],
    })

    // Verify subagent was spawned
    const children = await Session.getChildren(session.id)
    expect(children).toHaveLength(1)

    // Verify result received
    const messages = await Session.messages({ sessionID: session.id })
    const incoming = messages.flatMap((m) =>
      m.parts.filter((p) => p.type === "agent_message" && p.direction === "incoming"),
    )
    expect(incoming).toHaveLength(1)
  })
})
```

## Rollout Plan

### Stage 1: Internal Testing (1 week)

- Deploy with feature flag disabled
- Enable for specific test sessions only
- Run automated test suite continuously
- Monitor for errors and edge cases

### Stage 2: Opt-In Beta (1 week)

- Allow users to opt-in via configuration
- Collect feedback on behavior differences
- Fix any reported issues
- Document any breaking changes

### Stage 3: Default Enabled (1 week)

- Enable by default for new sessions
- Keep feature flag for rollback
- Monitor metrics (success rate, latency)
- Address any scaling issues

### Stage 4: Remove Legacy (1 week)

- Remove job system code
- Remove feature flag
- Update all documentation
- Final cleanup

## Risk Mitigation

### Risk 1: Parsing Failures

**Risk**: LLM doesn't produce valid XML format
**Mitigation**:

- Graceful fallback to plain text
- Robust parser with error recovery
- Clear system prompt examples

### Risk 2: Timeout Race Conditions

**Risk**: Message arrives while processing timeout
**Mitigation**:

- Use locks for wait state modifications
- Atomic check-and-update operations
- Comprehensive race condition tests

### Risk 3: Session Leaks

**Risk**: Orphaned subagent sessions
**Mitigation**:

- Cascade close on parent close
- Idle timeout garbage collection
- Session monitoring/cleanup job

### Risk 4: Backward Compatibility

**Risk**: Breaking existing workflows
**Mitigation**:

- Feature flag for gradual rollout
- Parallel operation during transition
- Clear migration documentation

## Success Metrics

| Metric             | Target |
| ------------------ | ------ |
| Test coverage      | >85%   |
| Parse success rate | >99%   |
| Timeout accuracy   | ±100ms |
| Memory per session | <1MB   |
| Latency overhead   | <50ms  |
| Error rate         | <0.1%  |

## Timeline Summary

| Week | Phase       | Deliverables                           |
| ---- | ----------- | -------------------------------------- |
| 1    | Foundation  | Types, session updates, parser         |
| 2    | Routing     | Message delivery, wait management      |
| 3    | Integration | Prompt loop changes, message injection |
| 4    | Tools       | subagent_spawn, session_close          |
| 5    | Prompts     | System prompt updates                  |
| 6    | Migration   | Feature flag, cleanup, documentation   |

**Total Duration: 6 weeks**

## Appendix: File Change Summary

### New Files

```
src/session/message-routing.ts    (~300 lines)
src/session/message-wait.ts       (~200 lines)
src/session/message-parser.ts     (~150 lines)
src/tool/subagent-spawn.ts        (~100 lines)
src/tool/session-close.ts         (~50 lines)
test/session/message-*.test.ts    (~500 lines)
test/tool/subagent-*.test.ts      (~200 lines)
test/integration/subagent-*.ts    (~400 lines)
specs/message-protocol.md         (this doc)
```

### Modified Files

```
src/session/index.ts              (+50 lines)
src/session/message-v2.ts         (+30 lines)
src/session/prompt.ts             (+100 lines, -50 lines job code)
src/session/system.ts             (+50 lines, -30 lines job code)
src/tool/registry.ts              (+10 lines)
src/agent/agent.ts                (+20 lines)
```

### Deleted Files

```
src/job/index.ts                  (-400 lines)
src/job/registry.ts               (-70 lines)
src/job/context.ts                (-230 lines)
src/job/stream.ts                 (-180 lines)
src/job/notification.ts           (-160 lines)
src/job/definitions/subagent.ts   (-200 lines)
src/tool/job.ts                   (-550 lines)
src/tool/job-generator.ts         (-230 lines)
src/tool/job-bridge.ts            (-80 lines)
```

### Net Change

- **New code**: ~1,900 lines
- **Removed code**: ~2,100 lines
- **Net reduction**: ~200 lines
- **Simpler architecture**: 2 tools vs 11+
