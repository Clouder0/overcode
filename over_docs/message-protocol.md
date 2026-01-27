# Inter-Agent Messaging

How agents communicate with each other using send and wait primitives.

---

## What It Is

Async subagents need a way to communicate. Inter-agent messaging provides the primitives for agents to exchange information, coordinate work, and share results.

Unlike human conversations, agent-to-agent communication is explicit and structured. Agents don't see each other's raw output by default—they must use the messaging tools.

---

## The Primitives

### send_agent_message

Send a message to another session:

```typescript
await send_agent_message({
  to: "ses_abc123", // Target session ID
  text: "Analysis complete. Found 3 security issues.", // Message content
})
```

### wait_agent_message

Wait for messages from other sessions:

```typescript
await wait_agent_message({
  sources: ["ses_abc123", "ses_def456"], // Sessions to wait for
  timeout: 300000, // 5 minutes
  mode: "all", // "all" or "any"
  since: 0, // -1 = from session start, 0 = from now, N = seq checkpoint
})
```

The `mode` parameter controls when the wait completes:

- `"all"` — Wait until every source has sent a message
- `"any"` — Wait until at least one source has sent a message

### Wait cursors (`since`)

Overcode assigns each delivered agent message a monotonic `seq` number. `wait_agent_message` uses `since` as a cursor so you can avoid accidentally matching old messages.

- `since: -1` — from session start (includes any past messages)
- `since: 0` — from now (recommended for most waits)
- `since: <seq>` — from a known checkpoint (advanced)

Delivered messages are rendered with `(seq: N)` in the header, so you can keep checkpoints when coordinating complex workflows.

Wildcard waits: `sources: ["*"]` with `mode: "any"` waits for the first message from any agent.

---

## Message Flow

### Sending

When an agent calls `send_agent_message`:

1. The message is queued for delivery
2. The target session is woken up (if idle)
3. The message appears in the target's inbox
4. The sender sees the completed tool call in their history

### Receiving

Messages appear in the receiving agent's conversation as user messages with special formatting:

```
Sender Agent with session id ses_abc123 (seq: 42) sent a message:
<content>
Analysis complete. Found 3 security issues.
</content>
```

The session ID is clickable in the TUI, allowing quick navigation.

### Waiting

When an agent calls `wait_agent_message`:

1. The agent enters a "waiting" state
2. Incoming messages from specified sources wake the agent
3. If all sources respond, the wait completes successfully
4. If the timeout expires, the wait fails gracefully with a status snapshot

---

## Key Concepts

### Strict Channel Separation

Agent output is never automatically visible to other agents. To communicate:

- Use `send_agent_message` for messages
- Messages are queued and persisted; the receiving agent does not need to be waiting to receive
- Use `wait_agent_message` when you want to pause until a response arrives

### Bounded Inbox

To keep long-running instances stable, Overcode keeps a bounded in-memory pending queue per session (capped at 200 messages). If a session receives a very large number of messages without processing them, older pending messages may be dropped.

In practice: batch progress updates and prefer periodic summaries over spamming many small messages.

### Timeouts Are Not Failures

A timeout means the wait deadline expired—it doesn't prove the other agent failed. The status snapshot tells you what the other agent was doing:

- **idle** — Agent was not processing anything
- **working** — Agent was actively processing
- **waiting** — Agent was waiting for something else
- **retry** — Agent was in retry state

### Human Messages Always Wake

A human message to a waiting agent wakes it immediately, bypassing the wait condition. This prevents agents from getting stuck waiting when the human wants to intervene.

---

## Common Patterns

### Fire-and-Wait

The simplest pattern for coordinated work:

```typescript
// 1. Spawn agents
await subagent_spawn({
  agents: [{ agent: "explore", prompt: "Analyze the codebase." }],
})

// 2. Wait for results
await wait_agent_message({
  sources: ["ses_explorer_id"],
  mode: "all",
  timeout: 600000,
  since: 0,
})
```

### Gather-Reduce

Collect results from multiple agents:

```typescript
await subagent_spawn({
  agents: [
    { agent: "explore", prompt: "Find all API endpoints." },
    { agent: "test", prompt: "Review test coverage." },
    { agent: "docs", prompt: "Check documentation completeness." },
  ],
})

await wait_agent_message({
  sources: ["ses_1", "ses_2", "ses_3"],
  mode: "all",
  timeout: 600000,
  since: 0,
})
```

### Streaming Updates

For long-running work, agents can send progress updates:

```typescript
// In subagent, periodically:
await send_agent_message({
  to: "ses_parent_id",
  text: `Progress: analyzed ${count} files out of ${total}`,
})
```

The parent receives these as regular messages and can display them or aggregate them.

### Free-Form Communication

This is where Overcode's power shines. Give agents each other's session IDs so they can consult each other directly, without going through an orchestrator.

```typescript
// Parent spawns agents with each other's IDs in context
// Then agents can communicate directly without the parent
await send_agent_message({
  to: "ses_other_agent_id",
  text: "I found an issue in the auth module. Can you verify?",
})
```

**This pattern enables the specialist consultation workflow:**

```typescript
// Week 1: Build a specialist
await subagent_spawn({
  agents: [
    {
      agent: "explore",
      prompt: "Become a permanent specialist in our authentication system.",
    },
  ],
})

// Week 3: Different task, need auth context
// Consult the specialist directly
await send_agent_message({
  to: "ses_auth_specialist_id",
  text: "Quick question: explain how our password reset flow works.",
})
```

---

## Human Interaction with Subagents

Human interaction with subagents happens directly in the TUI—not through messaging tools.

### The Problem with Centralized Orchestration

In traditional agent systems, all human interaction flows through a central orchestrator:

```
Human → Orchestrator → Subagent → Orchestrator → Human
```

Every clarification, every question, every side conversation pollutes the orchestrator's context. This creates noise and makes it hard to follow what's happening.

### The Overcode Solution

Subagents have isolated sessions. You can navigate directly to any subagent's session in the TUI and chat—just like chatting with any agent. The orchestrator never sees these conversations.

```
# In TUI, use the session picker or click-to-jump
# Navigate to ses_explorer_id
> Quick clarification: we use OAuth, not session-based auth.
```

### Benefits

**Clean orchestrator context.** Side conversations, clarifications, and human guidance stay in the subagent's session. The orchestrator sees only task input and output.

**Parallel human intervention.** While the orchestrator delegates and coordinates, you can iterate with individual subagents. Clarify requirements, redirect, debug—all without affecting the orchestrator.

**Flexible workflows.** Need to change a subagent's direction mid-task? Just chat with it directly in the TUI. No need to restart the entire workflow.

**Better audit trail.** Each subagent preserves its full interaction history, including human interventions. This makes it easier to understand how decisions were made.

### Example Workflow

```typescript
// Orchestrator spawns agents
await subagent_spawn({
  agents: [
    { agent: "explore", prompt: "Analyze the payment system." },
    { agent: "test", prompt: "Test payment flows." },
  ],
})
```

**In the TUI:**

1. Human navigates to the explore subagent's session
2. Human types: "We use Stripe for payments, not a custom solution. Please focus on Stripe integration points."
3. Explore updates its analysis with the correct context
4. Later, the test agent (not the human) can consult the explore agent for guidance via send_agent_message
5. Orchestrator receives clean, context-aware results from both agents

---

## Error Handling

### Unknown Session

If the target session doesn't exist, `send_agent_message` returns an error. Check the session ID.

### Delivery Failures

Messages are persisted to storage. If a session is interrupted, messages are delivered when it restarts.

### Permission Denied

Agents can only send to sessions that exist. Cross-session communication is always allowed between active sessions.

---

## Why We Built This

### Explicit Coordination

Implicit communication leads to confusion. With explicit messaging, it's clear what was sent, when, and to whom.

### Persistent Consultation

The messaging system is designed for long-living sessions. A specialist built today can be consulted next week, next month. The messaging layer handles the delivery regardless of time gaps.

### Free-Form Workflows

Traditional orchestrator patterns force all communication through a central coordinator. Free-form communication lets agents coordinate directly, enabling sophisticated multi-agent workflows.

### Human Oversight

Agents report back through messaging, so the human can see what subagents are doing without needing to inspect every session directly.

### Debugging

Message history makes it clear what information was shared between agents, simplifying troubleshooting.

---

## Advanced: Building Consultant Networks

The true power emerges when you build networks of specialists that consult each other:

```
Architecture Specialist ←→ Security Specialist
     ↓                      ↓
   Dev Agent ←─────────────→ Test Agent
```

Each agent knows which specialists to consult. When facing a question, they message the appropriate specialist directly. No central coordinator needed.

This mimics how real teams work: you don't route everything through a manager. You talk directly to the person with the expertise you need.
