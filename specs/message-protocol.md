# Unified Message-Based Agent Communication Protocol

## Overview

This document originally specified a unified XML-tag message protocol (`<message>` / `<wait>`) for agent communication in OpenCode.

## Status (deprecated)

The XML-tag protocol described below is no longer used by the runtime. OpenCode now uses tool-based agent↔agent messaging:

- `send_agent_message({ to: "ses_...", text: "..." })` (use explicit session IDs; subagents can send results to their Parent Session ID)
- `wait_agent_message({ sources: ["ses_..."], timeout: 60000, mode: "all" | "any" })`

Notes:

- `wait_agent_message` sources must be a non-empty list of explicit session IDs (no `"children"`, `"parent"`, or `"human"`).
- `wait_agent_message` timeout must be `> 0` milliseconds.
- XML tags like `<message>` / `<wait>` are not parsed for routing and will be shown as literal text.

Authoritative runtime guidance: `packages/opencode/src/session/system.ts`.

## Design Principles

1. **Unified Protocol**: Same message format for all communication paths
2. **Messages as First-Class**: Everything is a message, including timeouts
3. **Timeout-Based Modes**: Use timeout values to indicate wait behavior
4. **Recursive Composition**: Subagents can spawn subagents using the same protocol
5. **Integration-First**: Builds on existing message system, minimal disruption

## Protocol Specification

### Message Format (XML)

All agent responses that communicate with other sessions use XML format:

```xml
<message to="TARGET" timeout="TIMEOUT">
CONTENT
</message>
```

#### Attributes

| Attribute | Required | Type   | Description                                                 |
| --------- | -------- | ------ | ----------------------------------------------------------- |
| `to`      | Yes      | string | Target: `"human"`, `"parent"`, or session ID (`"ses_xxx"`)  |
| `timeout` | Yes      | number | Wait behavior: `-1` (infinite), `0` (none), or milliseconds |

#### Timeout Semantics

| Value   | Name          | Behavior                                        |
| ------- | ------------- | ----------------------------------------------- |
| `-1`    | Infinite wait | Send message, wait indefinitely for response    |
| `0`     | No wait       | Send message, continue working immediately      |
| `N > 0` | Timed wait    | Send message, wait N milliseconds, then timeout |

#### Target Resolution

| `to` Value  | Resolves To                               |
| ----------- | ----------------------------------------- |
| `"human"`   | Human operator (UI/terminal)              |
| `"parent"`  | Parent session that spawned this subagent |
| `"ses_xxx"` | Specific session by ID                    |

### Multiple Messages Per Turn

A response can contain multiple `<message>` elements:

```xml
<message to="ses_explore_001" timeout="0">Find authentication</message>
<message to="ses_librarian_001" timeout="0">Find JWT documentation</message>
<wait sources="ses_explore_001,ses_librarian_001" timeout="120000" mode="all"/>
```

#### Processing Rules

1. Messages are processed in order
2. `timeout="0"` messages are sent immediately, turn continues
3. `<wait>` element collects responses from multiple sources
4. If no `<wait>`, first message with `timeout != 0` determines wait behavior
5. If all messages have `timeout="0"`, turn continues (system injects "Continue")

#### CRITICAL: Single Wait Rule

- **At most ONE `<wait>` tag per turn**
- **`<wait>` MUST be the LAST element** - no messages allowed after `<wait>`
- Violation triggers a malformed response error and re-prompts the LLM

Valid:

```xml
<message to="ses_001" timeout="0">Task 1</message>
<message to="ses_002" timeout="0">Task 2</message>
<wait sources="ses_001,ses_002" timeout="60000" mode="all"/>
```

Invalid (multiple waits):

```xml
<message to="ses_001" timeout="0">Task 1</message>
<wait sources="ses_001" timeout="60000" mode="all"/>
<message to="ses_002" timeout="0">Task 2</message>  <!-- ERROR: message after wait -->
<wait sources="ses_002" timeout="30000" mode="any"/> <!-- ERROR: second wait -->
```

### Wait Element (Multi-Source)

For parallel fan-out patterns:

```xml
<wait sources="SOURCE1,SOURCE2,..." timeout="TIMEOUT" mode="all|any"/>
```

| Attribute | Required | Values      | Description                     |
| --------- | -------- | ----------- | ------------------------------- |
| `sources` | Yes      | string      | Comma-separated session IDs     |
| `timeout` | Yes      | number      | Total wait time in milliseconds |
| `mode`    | Yes      | `all`/`any` | Wait for all or first response  |

### Incoming Messages

Messages arrive in the receiving agent's context as:

```
[From SOURCE]:
CONTENT
```

#### Examples

```
[From ses_explore_001]:
Found authentication in src/auth/. It uses JWT middleware.

[From human]:
Yes, proceed with the changes.

[From system timeout ses_explore_001]:
Timeout after 30000ms waiting for response
```

#### Timeout Message Format

Timeouts are delivered as normal messages:

```
[From system timeout TARGET]:
Timeout after Nms waiting for response
```

The agent handles timeout naturally in its next turn, enabling graceful degradation.

## Communication Patterns

### Pattern 1: Normal Human Conversation

Standard chat is just a message to human with infinite wait:

```xml
<message to="human" timeout="-1">
Here's what I found in the codebase...
</message>
```

### Pattern 2: Progress Update (Continue Working)

Send intermediate results while continuing work:

```xml
<message to="human" timeout="0">
Found 500 files. Analyzing...
</message>
```

System injects "Continue" prompt, agent continues working.

### Pattern 3: Question with Timeout

Ask for input with automatic timeout handling:

```xml
<message to="human" timeout="30000">
Delete these files? (auto-proceed in 30s)
</message>
```

### Pattern 4: Subagent Task

Delegate work to a subagent (spawn includes initial message):

```xml
<tool:subagent_spawn>
  <agents>
    <agent type="explore" message="Find the authentication implementation"/>
  </agents>
</tool:subagent_spawn>

<!-- Wait for result -->
<wait sources="ses_explore_001" timeout="120000" mode="all"/>
```

### Pattern 5: Subagent Progress

Subagent reports progress to parent:

```xml
<message to="parent" timeout="0">
Found 50 files, analyzing...
</message>
```

### Pattern 6: Subagent Question

Subagent asks parent for clarification:

```xml
<message to="parent" timeout="30000">
Should I include test files?
</message>
```

### Pattern 7: Subagent Final Result

Subagent returns final result:

```xml
<message to="parent" timeout="-1">
Complete analysis: Authentication uses JWT...
</message>
```

### Pattern 8: Subagent to Human

Subagent asks human directly (bypassing parent):

```xml
<message to="human" timeout="-1">
This will delete important files. Proceed? [y/n]
</message>
```

### Pattern 9: Parallel Fan-Out

Send to multiple subagents and collect results:

```xml
<message to="ses_explore_001" timeout="0">Find auth</message>
<message to="ses_explore_002" timeout="0">Find database</message>
<wait sources="ses_explore_001,ses_explore_002" timeout="180000" mode="all"/>
```

### Pattern 10: Nested Subagents

Subagent spawns its own subagent:

```xml
<!-- In subagent context -->
<tool:subagent_spawn agent="librarian"/>
<message to="ses_librarian_001" timeout="60000">
Find JWT best practices
</message>
```

## Session Model

### Session Types

```typescript
interface Session {
  id: string // "ses_xxx"
  type: "primary" | "subagent"
  agent: string // Agent type name
  parent?: string // Parent session ID (for subagents)
  children: string[] // Child session IDs
  status: "active" | "waiting" | "completed"
}
```

### Session Lifecycle

```
Created (subagent_spawn)
    ↓
Active (processing turns)
    ↓
Waiting (timeout > 0, waiting for response)
    ↓
Active (response received)
    ↓
Completed (closed or garbage collected)
```

### Session Persistence

- Sessions persist until explicitly closed or garbage collected
- Child sessions are closed when parent closes
- Idle timeout triggers garbage collection

## System Prompt Integration

### Primary Agent System Prompt Addition

```
## Communication Protocol

Wrap all responses in message tags:

<message to="human" timeout="-1">
Your response here
</message>

Timeout values:
- timeout="-1": Wait for response (normal conversation)
- timeout="0": Send and continue (progress updates)
- timeout="N": Wait N milliseconds

For subagent tasks:
1. <tool:subagent_spawn agent="explore"/>
2. <message to="ses_xxx" timeout="120000">Task description</message>
3. Response arrives as: [From ses_xxx]: ...
```

### Subagent System Prompt Addition

```
## Session Context

You are a subagent.
Session ID: {SESSION_ID}
Parent: {PARENT_SESSION_ID}

## Communication Protocol

<message to="parent" timeout="TIMEOUT">
Your response
</message>

Patterns:
- Progress: timeout="0" (continue working)
- Question: timeout="30000" (wait for answer)
- Final: timeout="-1" (done, available for follow-up)
- To human: to="human" (bypass parent)
```

## Message Storage

### New Part Type: MessagePart

```typescript
interface MessagePart extends PartBase {
  type: "message"
  direction: "outgoing" | "incoming"
  peer: string // Session ID or "human"
  peerType: "human" | "agent"
  text: string // Message content
  timeout?: number // For outgoing messages
  timeoutOccurred?: boolean // True if this was a timeout message
}
```

### Storage Integration

Messages are stored as parts within existing MessageV2 structure:

```
Session
  └── Message (assistant turn)
        ├── TextPart (reasoning)
        ├── ToolPart (tool calls)
        ├── MessagePart (communication)
        └── WaitPart (wait state)
```

## UI Display Design

### Message Display Principles

1. **Direction via indentation**: Outgoing = left-aligned, Incoming = indented
2. **Arrows indicate flow**: `→` outgoing, `←` incoming
3. **Consistent content position**: Content always at 2-space indent from left
4. **Agent names over IDs**: Show `explore` not `ses_01JGQX5M3N12`

### Message Layout

```
→ human
  Hello world, I found the authentication implementation.

→ explore
  Find all authentication-related code in the codebase.

→ librarian
  Search for JWT documentation and examples.

      ⏳ explore, librarian (all, 60s)

            ← explore
  Found authentication in src/auth/middleware.ts. Uses JWT
  tokens with RS256 signing.

            ← librarian
  JWT best practices from Auth0 docs: Always validate issuer
  and audience claims.

→ human
  Based on the findings, here's my recommendation...
```

### Indent Rules

| Type               | Symbol        | Header Indent | Color   |
| ------------------ | ------------- | ------------- | ------- |
| Send to human      | `→ human`     | 0             | accent  |
| Send to agent      | `→ explore`   | 0             | accent  |
| Receive from agent | `← explore`   | 12            | primary |
| Wait (pending)     | `⏳ sources`  | 6             | warning |
| Wait (resolved)    | hidden or `✓` | 6             | success |
| Wait (timed out)   | `⏱ sources`  | 6             | error   |

### Wait State Display

**Waiting**:

```
      ⏳ explore, librarian (all, 60s)
```

**Resolved (all mode)**: Hide - responses are self-evident

**Resolved (any mode)**: Show who responded, who was abandoned

```
      ✓ explore · ○ librarian
```

**Partial timeout**: Show only failures

```
      ⏱ librarian timed out
```

**Full timeout**:

```
      ⏱ explore, librarian timed out
```

### Peer Name Resolution

Priority order for displaying peer names:

1. Agent type from session title: `"Subagent - explore"` → `explore`
2. Custom session title if set
3. Short ID suffix for disambiguation: `explore#3n12`

Never show raw session IDs like `ses_01JGQX5M3N12...`

### Streaming: Predictive Parsing

During streaming, hide incomplete `<message>` tags to prevent flickering:

```typescript
function getDisplayText(text: string, isStreaming: boolean): string {
  if (!isStreaming) return text

  // Find start of incomplete <message> tag (no closing </message>)
  const incompleteStart = text.search(/<message\b(?![^]*<\/message>)[^]*$/)
  if (incompleteStart > -1) {
    return text.slice(0, incompleteStart).trimEnd()
  }
  return text
}
```

## Tools

### subagent_spawn

Creates one or more subagent sessions with initial messages. This is a batched operation that spawns agents and sends their initial tasks in a single call.

```typescript
subagent_spawn({
  agents: [
    {
      agent: string,     // Agent type: "explore", "librarian", etc.
      message: string,   // Initial task/prompt for this agent
    },
    // ... more agents
  ]
}) → {
  spawned: [
    {
      session_id: string,  // Created session ID
      agent: string,       // Agent type
    },
    // ... for each agent
  ]
}
```

#### Single Agent Example

```xml
<tool:subagent_spawn>
  <agents>
    <agent type="explore" message="Find the authentication implementation"/>
  </agents>
</tool:subagent_spawn>
```

Result:

```json
{
  "spawned": [{ "session_id": "ses_explore_001", "agent": "explore" }]
}
```

#### Multiple Agents Example (Parallel Fan-Out)

```xml
<tool:subagent_spawn>
  <agents>
    <agent type="explore" message="Find authentication code"/>
    <agent type="explore" message="Find database code"/>
    <agent type="librarian" message="Find JWT best practices"/>
  </agents>
</tool:subagent_spawn>
```

Result:

```json
{
  "spawned": [
    { "session_id": "ses_explore_001", "agent": "explore" },
    { "session_id": "ses_explore_002", "agent": "explore" },
    { "session_id": "ses_librarian_001", "agent": "librarian" }
  ]
}
```

After spawning, use `<wait>` to collect responses:

```xml
<wait sources="ses_explore_001,ses_explore_002,ses_librarian_001" timeout="180000" mode="all"/>

## Error Handling

### Session Not Found

```

[From system error]:
Session ses_xxx not found

```

### Session Crashed

```

[From system error ses_xxx]:
Session crashed: Error details...

```

### Invalid Message Format

System logs error, attempts to extract content, falls back to plain text.

## Comparison with Job System

| Aspect            | Job System                  | Message Protocol                  |
| ----------------- | --------------------------- | --------------------------------- |
| Tools             | 11+ (job\_\*, bridge tools) | 2 (subagent_spawn, session_close) |
| Communication     | Tool calls                  | Structured output (XML)           |
| State storage     | Job frames                  | Message parts                     |
| Completion        | Explicit job_complete       | Natural (timeout=-1)              |
| Progress          | job_emit tool               | message with timeout=0            |
| Questions         | job_notify + wait           | message with timeout=N            |
| Timeout handling  | Complex wait logic          | Normal message from system        |
| Multi-source wait | Manual orchestration        | Native `<wait>` element           |

## Security Considerations

1. **Session ID Validation**: Verify session exists and parent has permission
2. **Cross-Session Access**: Only allow communication with related sessions
3. **Human Impersonation**: Prevent agents from spoofing human messages
4. **Timeout Limits**: Enforce maximum timeout values to prevent resource exhaustion

## Future Extensions

1. **Message Priority**: Urgent vs. normal messages
2. **Message Acknowledgment**: Delivery confirmation
3. **Broadcast**: Send to multiple sessions without waiting
4. **Session Groups**: Named groups for organized communication
```
