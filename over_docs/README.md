# Overcode Documentation

> A comprehensive guide to Overcode's unique features and modifications.

Overcode is a power-user fork of OpenCode, rebuilt from the ground up to support true asynchronous agent orchestration. This documentation covers the key features that distinguish Overcode from its upstream project.

---

## Core Philosophy

Overcode is built around three foundational principles:

1. **Async-First Design** — Multiple agents can run concurrently, communicate, and coordinate just like human teams do.

2. **TUI-Centric** — The terminal interface is the primary focus, with deep support for visualizing complex agent interactions.

3. **Performance Optimization** — Aggressive caching and caching-aware design significantly reduce token costs and latency.

---

## What's Covered

The following topics are documented in detail:

### Getting Started

- **[Async Subagents](async-subagents.md)** — The flagship feature. Spawn parallel agents, coordinate their work, and aggregate results.

- **[Inter-Agent Messaging](message-protocol.md)** — How agents communicate with each other using send and wait primitives.

### Performance Features

- **[Prompt Caching](prompt-caching.md)** — Dramatically reduce costs and latency with OpenAI's server-side prompt caching.

### Configuration & Control

- **[Subagent Permissions](subagent-permissions.md)** — Fine-grained control over which agents can spawn which subagents.

- **[Skill Tool Enhancement](skill-tools.md)** — Skills can now enable tools dynamically based on context.

### User Experience

- **[TUI Enhancements](tui-enhancements.md)** — Visual improvements for navigating nested sessions, monitoring progress, and managing complex workflows.

- **[Session Recovery](session-recovery.md)** — How interrupted runs are recovered (including orphan thinking omission markers).

---

## How to Use This Documentation

Each document is designed to be self-contained. You can read them in any order, though the **Async Subagents** and **Inter-Agent Messaging** guides are recommended first for understanding the core architecture.

For implementation details, configuration options, and developer documentation, see the [README](../README.md) and source code comments.

---

## Relationship to Upstream

Overcode diverged significantly from OpenCode in several areas:

- **Replaced the entire job system** with a new async subagent architecture
- **Added inter-agent messaging** with send/wait primitives
- **Focused exclusively on GPT, Claude, and Gemini** providers
- **Prioritized TUI** over SDK, API, and desktop app features

Some upstream features may work but are not actively maintained in Overcode. Bug fixes and security patches from upstream are cherry-picked as needed.
