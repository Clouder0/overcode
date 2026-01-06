# TUI Enhancements

Visual and functional improvements for navigating nested sessions, monitoring progress, and managing complex workflows.

---

## Session Tree View

The TUI displays your session hierarchy as an expandable tree:

```
Primary Session
 ├─ Subagent A (exploring)
 │   └─ Sub-subagent A1 (deep dive)
 └─ Subagent B (testing)
```

### Navigation

- Click on a session to view its conversation
- Use the session picker (accessible from the header) to browse and switch
- Session IDs in messages are clickable links

### Status Indicators

Each session shows its current state:

- **Working** — Actively processing
- **Waiting** — Waiting for messages from other sessions
- **Idle** — Ready for input
- **Done** — Task complete

---

## Child Session Picker

When you have multiple active sessions, use the picker to navigate:

1. Click the session picker button in the header
2. Browse the hierarchical list
3. Select the session you want to view
4. Click to confirm navigation

The picker shows:

- Session hierarchy with indentation
- Current status of each session
- Agent type for each session
- Parent session for context

---

## Cache Statistics

The sidebar displays real-time cache performance:

```
Cache Stats
━━━━━━━━━━━━━━━━━━━━
Hit Rate:     67%
Read Tokens:  45K
Write Tokens: 12K
Input Tokens: 57K
```

This helps you understand if your sessions are benefiting from prompt caching. Higher hit rates mean lower costs and faster responses.

---

## Paste Collapse/Expand

Large pasted content can be collapsed to save screen space:

- Collapsed pastes show a preview with character count
- Click to expand and view the full content
- Click again to collapse back
- Useful for long code snippets, error traces, or documentation

---

## Better Agent Message Styling

Messages from subagents are styled distinctly:

- Clear visual distinction from human messages
- Session ID badge for easy reference
- Source attribution for inter-agent messages
- Status indicators for waiting/timeout messages

---

## Click-to-Jump Navigation

Session references are clickable throughout the TUI:

- Session IDs in messages
- Parent session links in headers
- Source references in wait status
- Inter-agent message senders and receivers

Clicking jumps directly to that session's view.

---

## Subagent Spawn Dialog

When spawning subagents, a dialog shows:

- Available agent types (filtered by permissions)
- Input field for the task prompt
- Validation of inputs
- Confirmation before spawning

---

## Why We Built This

### Visibility

Complex agent workflows are hard to understand without visual representation. The session tree and status indicators make the workflow clear at a glance.

### Navigation

Jumping between sessions should be instant. Click-to-jump and the session picker eliminate the friction of managing multiple concurrent conversations.

### Feedback

Real-time statistics (cache hits, session status) help you understand what's happening and identify issues early.

---

## Tips

**Use the tree view** — When you have many subagents, the tree is the fastest way to understand the structure.

**Watch the cache stats** — Low hit rates may indicate session fragmentation.

**Collapse large pastes** — Keep your view clean by collapsing content you don't need to reference often.

**Click session IDs** — They're your fast path to any session in your workflow.
