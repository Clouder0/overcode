# Prompt Caching

Reduce token costs and latency by enabling OpenAI's server-side prompt caching.

---

## What It Is

OpenAI's prompt caching automatically caches repeated content in your requests. When you send similar prompts across multiple requests, the model can reuse cached tokens instead of reprocessing them. Cached tokens cost less and often process faster.

Overcode optimizes for this by:

1. **Session-based caching** — Using a consistent session ID across related requests
2. **Stable tool ordering** — Sorting tools deterministically so cache hits are maximized
3. **Environment pinning** — Caching system environment information during active sessions

---

## How It Works

### Session ID Header

Overcode sends the `x-session-id` header with OpenAI requests:

```typescript
headers: {
  "x-session-id": sessionID.replace(/^ses_/, "sess_"),
}
```

This tells OpenAI to treat requests within the same logical session as candidates for caching. The session ID persists throughout a conversation, maximizing cache reuse.

### Stable Tool Ordering

Tool definitions in your system prompt are sorted alphabetically. This ensures that if your tool list hasn't changed, the exact same tokens are sent, maximizing cache hits.

### Cached Environment

System environment information (working directory, file tree, local rules) is computed once per session and reused across requests. This significantly reduces the tokens needed for repeated context.

---

## Monitoring Cache Performance

The TUI displays cache statistics in the sidebar:

- **Hit percentage** — What fraction of input tokens were served from cache
- **Read tokens** — Tokens loaded from cache (cheaper)
- **Write tokens** — Tokens written to cache (one-time cost)
- **Input tokens** — Total input tokens for comparison

Higher hit percentages mean lower costs and faster responses.

---

## Why We Implemented This

### Cost Reduction

Cached tokens are significantly cheaper than uncached tokens. For long-running sessions with substantial system prompts, this can reduce your OpenAI bill by 30-50%.

### Latency Improvement

Cache hits skip the computation for those tokens, resulting in faster first-byte times and smoother streaming.

### User Experience

Lower costs encourage more experimentation. Users can run longer sessions without worrying about accumulating expenses.

---

## Best Practices

**Keep sessions coherent.** The caching works best when the logical "conversation" stays together. Don't fragment related work into disconnected sessions.

**Reuse agents.** If you're doing similar types of tasks, use the same agent configuration. The consistent system prompt maximizes cache hits.

**Monitor the stats.** The TUI cache stats help you understand if your sessions are benefiting from caching. Low hit rates may indicate fragmentation.

---

## Requirements

- OpenAI or Azure OpenAI provider
- Models that support prompt caching (most recent GPT-4 variants and GPT-3.5 Turbo do)
- Session ID must remain consistent across requests (handled automatically by Overcode)

Note: Other providers may have different caching mechanisms. Overcode focuses optimization on OpenAI as the primary provider.
