# Skill Tool Enhancement

Skills can now enable tools dynamically based on context.

---

## What It Is

Skills in Overcode provide specialized instructions for specific tasks. The enhancement allows skills to declare which tools they need, and those tools are automatically enabled when the skill is loaded.

This means skills are no longer just instructions—they become self-contained packages of capability.

---

## How to Use

### Declaring Tools in a Skill

Add a `tools` field to your skill's frontmatter:

```yaml
---
name: api_design
description: Design RESTful APIs with best practices
tools:
  - grep
  - read
  - write
  - glob
---
# API Design Guidelines

Follow these principles when designing REST APIs:
```

### Loading the Skill

When an agent loads this skill:

```typescript
await skill({ name: "api_design" })
```

The following happens automatically:

1. The skill's instructions are injected into the system prompt
2. The declared tools (`grep`, `read`, `write`, `glob`) are enabled for this session
3. The TUI shows which tools were enabled

---

## How It Works

### Session Tool Overrides

Overcode maintains a per-session override for tool availability. When a skill declares tools, those tools are added to the session's override list so they can be used in that session (subject to normal permissions).

This does not bypass denied permissions; it mainly affects tool availability for the session.

### Subagent Isolation

Tool enabling via skills is only available to primary sessions. Subagents spawned by async subagents do not get tool enabling capabilities, preventing skills from escalating privileges across session boundaries.

### Multiple Skills

If multiple skills are loaded, their tool lists are combined. Duplicate entries are deduplicated.

---

## Why We Built This

### Self-Contained Skills

A skill should provide everything needed for its task. Instructions plus tools. This makes skills portable and self-documenting.

### Dynamic Configuration

Instead of configuring tools globally, skills can bring their own capabilities. This is especially useful for domain-specific skills that need specialized tools.

### Discovery

The TUI shows which tools a skill enabled, making it clear what capabilities are available. This helps agents understand what they can do.

---

## Best Practices

### Minimal Tool Declarations

Only declare tools that the skill actually uses. This keeps the tool list clean and makes it easier to understand what the skill needs.

### Document Tool Usage

In the skill's content, explain why each tool is needed. This helps future maintainers understand the skill's requirements.

### Consider Permissions

If your skill enables tools, consider who should be allowed to use it. Skills that enable powerful tools should be restricted appropriately.

---

## Example Skills

### Database Migration Skill

```yaml
---
name: db_migration
tools:
  - bash
  - read
  - write
  - todowrite
---

# Database Migration Guidelines

When creating migrations:
1. Always create reversible migrations
2. Test migrations in a safe environment
3. Document changes in a changelog
```

### Code Review Skill

```yaml
---
name: code_review
tools:
  - grep
  - read
  - glob
---

# Code Review Standards

Review pull requests for:
1. Code style consistency
2. Security vulnerabilities
3. Test coverage
4. Documentation updates
```
