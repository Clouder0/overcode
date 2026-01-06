# Async Subagents

Spawn parallel agents, coordinate their work, and aggregate results. This is the flagship feature of Overcode.

---

## What It Is

Traditional agent systems run one agent at a time. You give it a task, it completes, then you give it another. This sequential model works for simple tasks but becomes a bottleneck when you need to accomplish complex goals that could benefit from parallel execution.

Async subagents change this fundamentally. Instead of one agent doing everything, you can spawn multiple agents simultaneously, each handling a different aspect of your problem. They run in parallel, communicate as needed, and report back their results.

Think of it like a team of specialists working together:

```
Primary Session
 ├─ Subagent A (exploring the codebase)
 │   └─ Sub-subagent A1 (deep dive into module X)
 └─ Subagent B (running tests)
```

---

## Long-Living Sessions

Here's what makes Overcode truly powerful: **subagent sessions persist beyond their initial task**.

Most agent systems treat agents as ephemeral—one task, then gone. Overcode subagents are different. They live on, accumulating context and expertise. Later, you can consult them again to tap into their accumulated knowledge.

### The Specialist Pattern

Imagine you spawn a specialist to deeply analyze your authentication system:

```typescript
await subagent_spawn({
  agents: [
    {
      agent: "explore",
      prompt:
        "Become a specialist in our authentication system. Map all components, understand the flows, identify the security-critical parts. This is your permanent specialty now.",
    },
  ],
})
```

Three weeks later, you're working on a completely different task and need to know: "How does password reset work in our auth system?"

Instead of starting from scratch:

```typescript
// Consult the specialist you built earlier
await send_agent_message({
  to: "ses_auth_specialist_id",
  text: "Quick question: explain how our password reset flow works, including all the key components involved.",
})
```

The specialist already knows your codebase. It has context you don't need to rebuild. It gives you a precise answer immediately.

---

## Human Interaction with Subagents

Here's another powerful capability: **you can chat directly with any subagent**.

In traditional agent systems, all interaction flows through a central orchestrator. Every question, every clarification, every side conversation pollutes the orchestrator's context. This creates noise and makes it hard to follow what's happening.

Overcode changes this. Subagents have their own isolated sessions. You can jump in, ask questions, clarify requirements, or provide guidance—without affecting the orchestrator's conversation.

### How It Works

The orchestrator delegates tasks to multiple subagents:

```typescript
await subagent_spawn({
  agents: [
    { agent: "explorer", prompt: "Analyze the authentication module." },
    { agent: "test", prompt: "Write tests for auth module." },
    { agent: "docs", prompt: "Document auth module APIs." },
  ],
})
```

Now you have three active subagents, each working independently.

### Direct Human Interaction

Human interaction happens directly in the TUI. You can switch to any subagent's session and chat just like you would with any agent:

```
# In TUI, navigate to ses_explorer_id session
> What assumptions are you making about the auth flow?
```

The orchestrator doesn't see this conversation. It only sees the final result when the subagent reports back.

### Why This Matters

**Clean orchestrator context.** Side conversations, clarifications, and human guidance stay in the subagent's session. The orchestrator sees only the relevant task output.

**Parallel human intervention.** While the orchestrator delegates and coordinates, you can iterate with individual subagents. Clarify requirements with one, provide guidance to another—all without interrupting the overall workflow.

**Flexible workflows.** Sometimes you need to change a subagent's direction mid-task. With direct access, you can redirect without restarting the entire workflow.

**Audit trail.** Each subagent's session preserves its entire interaction history, including human interventions. This makes it easier to understand how decisions were made.

---

## How to Use

### Spawning Subagents

Use the `subagent_spawn` tool to create new agent sessions:

```typescript
await subagent_spawn({
  agents: [
    {
      agent: "explore",
      prompt: "Analyze the authentication module and identify all security-critical code paths.",
    },
    {
      agent: "test",
      prompt: "Write comprehensive tests for the user authentication flow.",
    },
  ],
})
```

Each subagent gets its own isolated session with:

- Its own conversation history
- Its own tool access (controlled by permissions)
- Knowledge of its parent session ID
- Persistent state that survives across consultations

### Consulting Existing Sessions (Agent-to-Agent)

Agents can consult specialists using send_agent_message:

```typescript
// Agent consults a specialist
await send_agent_message({
  to: "ses_specialist_id",
  text: "I need your expertise on: [your question]",
})
```

### Waiting for Responses

If the agent might be idle or busy, wait for its response:

```typescript
await wait_agent_message({
  sources: ["ses_specialist_id"],
  timeout: 300000, // 5 minutes
  mode: "all",
})
```

---

## Communication Patterns

Overcode supports several common patterns:

### Fire-and-Wait

Spawn agents, wait for all to complete, then aggregate results.

### Gather-Reduce

Spawn multiple agents, collect responses, combine into a single deliverable.

### Streaming

Spawn an agent that sends progress updates as it works, without waiting for final completion.

### Free-Form Communication

Give agents each other's session IDs so they can consult each other directly. This is where the specialist pattern shines:

```typescript
// Parent spawns agents and gives them each other's IDs
// They can now consult each other on-demand without the parent
```

---

## Why We Built This

### True Parallelism

Sequential agent execution is slow. If your task has three independent components, running them one after another takes 3× the time of a single component. With async subagents, all three run simultaneously.

### Persistent Expertise

Most agent systems forget everything after each task. Overcode subagents remember. You build specialists that accumulate knowledge over days or weeks. When you need their expertise, you consult them instead of starting over.

### On-Demand Consultation

The free-form communication model lets agents consult each other whenever they need help. A coding agent can ask a documentation specialist for context. A test agent can consult an architecture specialist about system design.

### Cost Efficiency

Parallel execution often costs less than sequential because:

- Different agents can use different, cheaper models
- Shorter individual conversations reduce total token usage
- Reusing specialists avoids rebuilding context
- Timeouts and retries can be handled per-agent

---

## The Specialist Pattern in Detail

This is one of Overcode's most powerful features. Here's how it works:

### Phase 1: Build the Specialist

```typescript
await subagent_spawn({
  agents: [
    {
      agent: "explore",
      prompt: `Become a long-running specialist in [domain].
Your job is to build deep understanding of this area.
Remember everything—components, flows, patterns, decisions.
When consulted, provide detailed, accurate answers based on your accumulated knowledge.
`,
    },
  ],
})
```

The specialist spends time building context. It explores, asks questions, and develops expertise.

### Phase 2: Consult on Demand

Weeks or months later, when someone needs information:

```typescript
await send_agent_message({
  to: "ses_specialist_id",
  text: `I need to understand [specific question about domain].
Please explain with the depth of someone who has studied this area thoroughly.`,
})
```

The specialist responds with rich context drawn from its accumulated knowledge.

### Phase 3: Iterate and Improve

The specialist can continue learning:

```typescript
await send_agent_message({
  to: "ses_specialist_id",
  text: `We just made changes to [component]. Please:
1. Analyze the changes
2. Update your understanding of [affected areas]
3. Identify any new risks or considerations`,
})
```

---

## Key Concepts

### Session Hierarchy

Every subagent knows its parent session ID. This creates a tree structure you can navigate in the TUI. The hierarchy is preserved in exports and can be useful for understanding who spawned whom.

### Isolated State

Subagents have their own tool access, permission overrides, and conversation history. They cannot interfere with each other's state, but they can communicate through messaging.

### Persistent Sessions

Subagents don't disappear after their initial task. They remain active and can be consulted indefinitely. Their accumulated context makes each subsequent consultation more valuable.

### Error Handling

If a subagent crashes, the parent session is notified via inter-agent messaging. The parent can decide to respawn, work around the failure, or abort the entire workflow.

### Permissions

By default, agents can spawn any subagent. You can configure fine-grained permissions to restrict which agents can spawn which subagents. See [Subagent Permissions](subagent-permissions.md) for details.

---

## Tips for Effective Use

**Build specialists intentionally.** A subagent with a single, clear objective performs better than one juggling multiple concerns.

**Give specialists clear domains.** "Authentication specialist" is better than "knows everything about the codebase."

**Use descriptive prompts.** Tell subagents exactly what to deliver and when the task is complete.

**Set appropriate timeouts.** Subagents working on complex analysis need longer timeouts than those doing simple lookups.

**Monitor in the TUI.** The session tree view shows you the status of all active subagents in real time.

**Consult before spawning.** Before creating a new agent, check if an existing specialist already has the context you need. Reusing context is faster and cheaper.

---

## Real-World Examples

### Architecture Specialist

Build a specialist to deeply understand your system architecture. Later, when making changes, consult it to understand impact areas.

### Domain Expert

Create a specialist for a complex business domain. Team members can consult it to understand business rules and decisions.

### Legacy Code Expert

Spawn a specialist to understand legacy code. It becomes your institutional knowledge base for difficult-to-understand systems.

### Test Suite Expert

Build a specialist that understands your test infrastructure. Consult it when writing new tests to ensure consistency with existing patterns.
