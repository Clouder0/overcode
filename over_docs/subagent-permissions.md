# Subagent Permissions

Fine-grained control over which agents can spawn which subagents.

---

## What It Is

By default, any agent can spawn any subagent. This is convenient but can be problematic in production or security-sensitive environments. Subagent permissions let you restrict which agents are allowed to spawn which subagents.

This is configured per-agent, allowing different spawning rules for different workflows.

---

## Configuration

Add `subagent_spawn_agent` to your agent's permission configuration:

```yaml
# In .opencode/agents/coordinator.md
permission:
  subagent_spawn: allow
  subagent_spawn_agent:
    "*": deny
    "explore": allow
    "test": allow
    "docs": allow
```

### How It Works

The `subagent_spawn_agent` map uses wildcard patterns:

- `"*"` matches all agents
- Specific agent names match only that agent
- Patterns are evaluated in order; last match wins (put `"*"` first, then overrides)

### Mode Detection

Overcode automatically detects whether you're using an allowlist or denylist:

- If `"*": "deny"` is present, only explicitly listed agents can be spawned
- If `"*": "allow"` is present, listed agents are explicitly denied

This allows intuitive configurations for both use cases.

---

## Example Configurations

### Restrictive (Allowlist)

Only allow spawning of specific subagents:

```yaml
permission:
  subagent_spawn_agent:
    "*": deny
    "explore": allow
    "test": allow
```

### Permissive (Denylist)

Allow all subagents except specific ones:

```yaml
permission:
  subagent_spawn_agent:
    "*": allow
    "experimental": deny
    "deprecated_agent": deny
```

### Per-Agent Granularity

Different agents have different spawning rights:

```yaml
permission:
  subagent_spawn_agent:
    # Coordinator can spawn anything
    "*": allow
---
# In .opencode/agents/limited_worker.md
permission:
  subagent_spawn_agent:
    # Can only spawn docs agent
    "*": deny
    "docs": allow
```

---

## What Happens When Denied

If an agent tries to spawn a denied subagent:

1. The spawn request fails immediately
2. An error message explains which subagent was denied
3. The error includes the matched pattern for debugging
4. No subagents are spawned in that request until permissions are fixed

Preflight validation catches all denials before spawning begins, so you get a complete list of issues at once.

---

## Why We Built This

### Security

In production, you may want to restrict which workflows can spawn resource-intensive subagents, or prevent experimental agents from spawning anything.

### Cost Control

Different teams or workflows may have different budgets. Permissions let you restrict expensive subagents to authorized workflows only.

### Safety

Prevent accidental spawns of subagents that require specific permissions or configurations.

---

## Requirements

This feature requires the `subagent_spawn` permission to be set to `allow` (or the default). If `subagent_spawn` is `deny`, no spawning is allowed regardless of `subagent_spawn_agent` configuration.

---

## Debugging

When a spawn fails, the error message includes:

- The subagent name that was denied
- The pattern that matched the denial
- The calling agent's configuration context

This makes it straightforward to identify and fix permission issues.
