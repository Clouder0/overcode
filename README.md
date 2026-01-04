# Overcode

> **A power-user fork of [OpenCode](https://github.com/sst/opencode)** — async subagents, nested sessions, TUI-focused.



https://github.com/user-attachments/assets/e111ba85-9757-4d82-8a77-20a1266790d8



---

## Philosophy

| Principle                       | What It Means                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **GPT / Claude / Gemini First** | We explicitly focus on these three providers. Others may work (synced from upstream) but are not actively maintained.      |
| **TUI First**                   | Only the Terminal UI is actively maintained. SDK, API endpoints, Desktop App, etc. may have issues — use at your own risk. |
| **Flexibility**                 | Configurable agents, models, permissions, prompts — everything bends to your workflow.                                     |
| **Power First**                 | Advanced features for power users who demand full control.                                                                 |

---

## Maintenance Scope

| Component     | Status                                  |
| ------------- | --------------------------------------- |
| **TUI**       | ✅ Actively maintained                  |
| SDK           | ⚠️ Synced from upstream, not maintained |
| API Endpoints | ⚠️ Synced from upstream, not maintained |
| Desktop App   | ⚠️ Synced from upstream, not maintained |
| Web Console   | ⚠️ Synced from upstream, not maintained |

| Provider                | Status                                  |
| ----------------------- | --------------------------------------- |
| **OpenAI (GPT, Codex)** | ✅ Actively maintained                  |
| **Anthropic (Claude)**  | ✅ Actively maintained                  |
| **Google (Gemini)**     | ✅ Actively maintained                  |
| Others                  | ⚠️ Synced from upstream, not maintained |

---

## Key Features

### 1. Async Subagent System

The flagship feature. A complete rework of agent orchestration:

- **Nested sessions** — Spawn subagents that can spawn their own subagents
- **True async execution** — Multiple agents run in parallel, not sequentially
- **Inter-agent messaging** — Agents communicate via `send_agent_message` / `wait_agent_message`
- **Flexible patterns** — Fire-and-wait, streaming updates, fire-and-forget

```
Primary Session
 ├─ Subagent A (exploring)
 │   └─ Sub-subagent A1 (deep dive)
 └─ Subagent B (testing)
```

**New tools:**

| Tool                 | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `subagent_spawn`     | Spawn subagents with custom prompts               |
| `send_agent_message` | Send messages to other sessions                   |
| `wait_agent_message` | Wait for responses (`all` / `any` mode + timeout) |

---

### 2. GPT/Codex Session Cache Fix

The most critical optimization: **`x-session-id` header for OpenAI requests**.

```typescript
// Enables OpenAI's server-side prompt caching
headers: {
  "x-session-id": sessionID.replace(/^ses_/, "sess_"),
}
```

This allows OpenAI to cache prompts across requests within the same session, significantly reducing:

- **Token costs** — Cached tokens are cheaper
- **Latency** — Cached prompts process faster

Additional optimizations:

- **Stable tool ordering** — Tools sorted deterministically to maximize cache reuse
- **Environment caching** — System environment pinned during active sessions
- **Cache stats in TUI** — Monitor hit percentage in the sidebar

---

### 3. Enhanced TUI Experience

- **Nested session navigation** — Visual tree view of all spawned agents
- **Session state indicators** — See which agents are working / waiting / done
- **Click-to-jump** — Click subsession references to navigate directly
- **Subagent session picker** — Browse and switch between sessions in the hierarchy
- **Paste collapse/expand** — Toggle large pasted content between collapsed and expanded view

---

### 4. Error Handling & Recovery

- **Orphan reasoning recovery** — GPT/Codex models sometimes emit reasoning without final output; we detect and recover gracefully with context preservation
- **Hardened crash recovery** — Better handling of interrupted sessions and missing tool results
- **Trash recovery fixes** — Improved resilience for corrupted session state

---

### 5. Provider Fixes

| Provider               | Fix                                                          |
| ---------------------- | ------------------------------------------------------------ |
| **OpenAI (GPT/Codex)** | Session ID header for caching, orphan reasoning sanitization |
| **Anthropic (Claude)** | Tool ID normalization, cache control                         |
| **Google (Gemini)**    | Temperature/topP defaults                                    |

---

## Installation

### Pre-built Binaries

Download from [GitHub Releases](https://github.com/Clouder0/overcode/releases), extract, and copy to your PATH:

```bash
# Example for Linux x64
tar -xzf opencode-linux-x64.tar.gz
cp opencode-linux-x64/bin/opencode ~/.local/bin/
```

### Build from Source

```bash
git clone https://github.com/Clouder0/overcode.git
cd overcode
bun install

# Build for current platform
cd packages/opencode
bun run build --single

# Binary will be at dist/opencode-<os>-<arch>/bin/opencode
# Copy to your PATH, e.g.:
cp dist/opencode-linux-x64/bin/opencode ~/.local/bin/
# or
cp dist/opencode-darwin-arm64/bin/opencode ~/.local/bin/
```

---

## Relationship to Upstream

This is a **personal fork** with significant divergence from [OpenCode](https://github.com/sst/opencode).

- **Does not track upstream directly** — Cherry-picks specific bug fixes and security patches
- **Narrow maintenance scope** — TUI + GPT/Claude/Gemini only
- **Different architecture** — Nested session model with async subagents

---

## License

Same license as upstream OpenCode. See [LICENSE](./LICENSE).

---

<sub>Based on [OpenCode](https://github.com/sst/opencode). This is a personal fork — not affiliated with or endorsed by the OpenCode team.</sub>
