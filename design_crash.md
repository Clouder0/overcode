# Crash Recovery & Auto-Compact Design Document

**Purpose**: This document describes the crash detection, failure recovery, and auto-compaction mechanisms implemented in oh-my-opencode. It provides sufficient detail to replicate these features in another system.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Session Recovery](#session-recovery)
4. [Anthropic Auto-Compact](#anthropic-auto-compact)
5. [Supporting Hooks](#supporting-hooks)
6. [Storage Layer](#storage-layer)
7. [Configuration](#configuration)
8. [Implementation Notes](#implementation-notes)

---

## Overview

The system implements **defense-in-depth** recovery across multiple failure categories:

| Category | Hook | Trigger | Recovery Strategy |
|----------|------|---------|-------------------|
| API structural errors | `session-recovery` | Claude API errors | Filesystem patching |
| Token limit exceeded | `anthropic-auto-compact` | Context overflow | Truncate → Summarize → Revert |
| Empty messages | `empty-message-sanitizer` | Missing content | Placeholder injection |
| Empty task responses | `empty-task-response-detector` | Task tool returns nothing | Warning injection |
| Incomplete work | `todo-continuation-enforcer` | Agent stops with pending todos | Auto-resume prompt |
| Context anxiety | `context-window-monitor` | High context usage | Reassurance injection |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     EVENT STREAM (OpenCode SDK)                     │
│  session.error | session.idle | message.updated | session.deleted  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     DETECTION LAYER                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ Error Pattern   │  │ Token Limit     │  │ Empty Content       │  │
│  │ Matching        │  │ Parser          │  │ Detection           │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
└───────────┼─────────────────────┼─────────────────────┼─────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     RECOVERY LAYER                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │ Storage         │  │ Session         │  │ Message             │  │
│  │ Patching        │  │ Compaction      │  │ Injection           │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
└───────────┼─────────────────────┼─────────────────────┼─────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     CONTINUATION LAYER                               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  session.prompt() → "Continue" / Resume with context         │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Session Recovery

### Purpose

Detect and fix Claude API structural errors by patching the local message storage before retry.

### Error Types Handled

#### 1. Tool Result Missing (`tool_result_missing`)

**Cause**: User presses ESC mid-tool-call. Claude expects `tool_result` for every `tool_use`.

**Detection**:
```typescript
if (message.includes("tool_use") && message.includes("tool_result")) {
  return "tool_result_missing"
}
```

**Recovery**:
```typescript
// Extract tool_use IDs from failed assistant message
const toolUseIds = parts
  .filter(p => p.type === "tool_use" && p.id)
  .map(p => p.id)

// Inject synthetic tool_result for each
const toolResultParts = toolUseIds.map(id => ({
  type: "tool_result",
  tool_use_id: id,
  content: "Operation cancelled by user (ESC pressed)",
}))

await client.session.prompt({
  path: { id: sessionID },
  body: { parts: toolResultParts },
})
```

#### 2. Thinking Block Order (`thinking_block_order`)

**Cause**: Claude's thinking block is not the first part in assistant message.

**Detection**:
```typescript
if (message.includes("thinking") && 
    (message.includes("first block") || 
     message.includes("must start with") ||
     message.includes("preceeding"))) {
  return "thinking_block_order"
}
```

**Recovery**: Prepend synthetic thinking part with lexicographically-first ID:
```typescript
function prependThinkingPart(sessionID: string, messageID: string): boolean {
  const partDir = join(PART_STORAGE, messageID)
  
  // ID starts with "0000000000" to sort before other parts
  const partId = `prt_0000000000_thinking`
  const part = {
    id: partId,
    sessionID,
    messageID,
    type: "thinking",
    thinking: "",
    synthetic: true,
  }
  
  writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(part))
  return true
}
```

#### 3. Thinking Disabled Violation (`thinking_disabled_violation`)

**Cause**: Message contains thinking blocks but model has thinking disabled.

**Detection**:
```typescript
if (message.includes("thinking is disabled") && 
    message.includes("cannot contain")) {
  return "thinking_disabled_violation"
}
```

**Recovery**: Delete all thinking parts from filesystem:
```typescript
function stripThinkingParts(messageID: string): boolean {
  const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"])
  
  for (const file of readdirSync(partDir)) {
    const part = JSON.parse(readFileSync(join(partDir, file)))
    if (THINKING_TYPES.has(part.type)) {
      unlinkSync(join(partDir, file))
    }
  }
}
```

#### 4. Empty Content (`empty_content`)

**Cause**: Assistant message has no text content (only thinking, or empty parts).

**Detection**: Error message contains `"non-empty content"`

**Recovery**: Inject placeholder text or replace empty text parts:
```typescript
const PLACEHOLDER_TEXT = "[user interrupted]"

// Option 1: Replace empty text parts
function replaceEmptyTextParts(messageID: string, text: string): boolean {
  for (const part of parts) {
    if (part.type === "text" && !part.text?.trim()) {
      part.text = text
      part.synthetic = true
      writeFileSync(partPath, JSON.stringify(part))
    }
  }
}

// Option 2: Inject new text part
function injectTextPart(sessionID: string, messageID: string, text: string): boolean {
  const newPart = {
    id: generatePartId(),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic: true,
  }
  writeFileSync(join(partDir, `${newPart.id}.json`), JSON.stringify(newPart))
}
```

### Recovery Flow

```
message.updated event (with error)
         │
         ▼
┌─────────────────────┐
│ detectErrorType()   │ ──── null ───► Ignore
└─────────┬───────────┘
          │ RecoveryErrorType
          ▼
┌─────────────────────┐
│ session.abort()     │ ◄── Stop current generation
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Fetch messages from │
│ session API         │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ Apply recovery by   │
│ error type          │
└─────────┬───────────┘
          │
          ▼ (if experimental.auto_resume)
┌─────────────────────┐
│ Extract last user   │
│ message config      │
│ Resume with prompt  │
└─────────────────────┘
```

### Coordination State

```typescript
// Prevent duplicate processing
const processingErrors = new Set<string>()

// Callbacks for hook coordination
let onAbortCallback: (sessionID: string) => void
let onRecoveryCompleteCallback: (sessionID: string) => void

// Usage: todo-continuation-enforcer checks this to avoid fighting
onAbortCallback(sessionID)  // Mark recovering BEFORE abort
// ... recovery logic ...
onRecoveryCompleteCallback(sessionID)  // Mark done in finally block
```

---

## Anthropic Auto-Compact

### Purpose

Handle token limit exceeded errors with multi-stage fallback recovery.

### Error Detection

Parse various error formats to extract token information:

```typescript
interface ParsedTokenLimitError {
  currentTokens: number      // Actual tokens used
  maxTokens: number          // Model's limit
  requestId?: string
  errorType: string
  providerID?: string
  modelID?: string
  messageIndex?: number      // For empty content errors
}

const TOKEN_LIMIT_PATTERNS = [
  /(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
  /prompt.*?(\d+).*?tokens.*?exceeds.*?(\d+)/i,
  /(\d+).*?tokens.*?limit.*?(\d+)/i,
  /context.*?length.*?(\d+).*?maximum.*?(\d+)/i,
]

const TOKEN_LIMIT_KEYWORDS = [
  "prompt is too long",
  "context_length_exceeded",
  "max_tokens",
  "token limit",
  "too many tokens",
  "non-empty content",
]
```

### Recovery Stages

```
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 1: TRUNCATE LARGEST TOOL OUTPUT                               │
├─────────────────────────────────────────────────────────────────────┤
│ • Find largest tool result in session                               │
│ • Replace output with truncation message                            │
│ • Retry with "Continue" prompt                                      │
│ • Max attempts: 20                                                  │
│ • Min size to truncate: 500 bytes                                   │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (if still over limit)
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 2: AGGRESSIVE TRUNCATION (experimental)                       │
├─────────────────────────────────────────────────────────────────────┤
│ • Calculate tokens to reduce: currentTokens - (maxTokens × 0.5)    │
│ • Convert to chars: tokensToReduce × 4                              │
│ • Truncate ALL tool outputs until target reached                    │
│ • Retry with "Continue" prompt                                      │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (if still over limit)
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 3: SUMMARIZE SESSION                                          │
├─────────────────────────────────────────────────────────────────────┤
│ • Call session.summarize() API                                      │
│ • Compacts conversation history                                     │
│ • Retry with exponential backoff                                    │
│ • Max attempts: 2, delay: 2s → 4s (capped at 30s)                  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (if summarize fails)
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 4: REVERT LAST MESSAGE PAIR                                   │
├─────────────────────────────────────────────────────────────────────┤
│ • Find last user + assistant message pair                           │
│ • Call session.revert() for assistant, then user                    │
│ • Effectively "undo" the last exchange                              │
│ • Max attempts: 3                                                   │
│ • Requires minimum 2 messages in session                            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (all failed)
┌─────────────────────────────────────────────────────────────────────┐
│ Stage 5: GIVE UP                                                    │
├─────────────────────────────────────────────────────────────────────┤
│ • Show error toast to user                                          │
│ • "All recovery attempts failed. Please start a new session."      │
│ • Clear all session state                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### State Management

```typescript
interface AutoCompactState {
  // Sessions pending compaction
  pendingCompact: Set<string>
  
  // Parsed error data per session
  errorDataBySession: Map<string, ParsedTokenLimitError>
  
  // Summarize retry state
  retryStateBySession: Map<string, RetryState>
  
  // Revert fallback state
  fallbackStateBySession: Map<string, FallbackState>
  
  // Truncation state
  truncateStateBySession: Map<string, TruncateState>
  
  // Empty content fix attempts
  emptyContentAttemptBySession: Map<string, number>
  
  // Prevent concurrent compaction
  compactionInProgress: Set<string>
}

interface RetryState {
  attempt: number
  lastAttemptTime: number  // For cooldown (5 min reset)
}

interface FallbackState {
  revertAttempt: number
  lastRevertedMessageID?: string
}

interface TruncateState {
  truncateAttempt: number
  lastTruncatedPartId?: string
}
```

### Configuration Constants

```typescript
const RETRY_CONFIG = {
  maxAttempts: 2,
  initialDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 30000,
}

const FALLBACK_CONFIG = {
  maxRevertAttempts: 3,
  minMessagesRequired: 2,
}

const TRUNCATE_CONFIG = {
  maxTruncateAttempts: 20,
  minOutputSizeToTruncate: 500,  // bytes
  targetTokenRatio: 0.5,         // Target 50% of max
  charsPerToken: 4,              // Approximation
}
```

### Tool Output Truncation

```typescript
const TRUNCATION_MESSAGE = "[TOOL RESULT TRUNCATED - Context limit exceeded. " +
  "Original output was too large and has been truncated to recover the session. " +
  "Please re-run this tool if you need the full output.]"

interface StoredToolPart {
  id: string
  type: "tool"
  tool: string
  state: {
    status: string
    output?: string
    time?: { compacted?: number }
  }
  truncated?: boolean      // Flag for truncated parts
  originalSize?: number    // Original output size
}

function truncateToolResult(partPath: string): Result {
  const part = JSON.parse(readFileSync(partPath))
  
  part.truncated = true
  part.originalSize = part.state.output.length
  part.state.output = TRUNCATION_MESSAGE
  part.state.time.compacted = Date.now()
  
  writeFileSync(partPath, JSON.stringify(part))
}
```

### Event Handlers

```typescript
function createAnthropicAutoCompactHook(ctx) {
  return {
    event: async ({ event }) => {
      // Handle session deletion - cleanup state
      if (event.type === "session.deleted") {
        clearSessionState(sessionID)
        return
      }
      
      // Primary trigger: session.error
      if (event.type === "session.error") {
        const parsed = parseAnthropicTokenLimitError(error)
        if (parsed) {
          pendingCompact.add(sessionID)
          errorDataBySession.set(sessionID, parsed)
          
          // Immediate truncation attempt
          setTimeout(() => executeCompact(...), 300)
        }
        return
      }
      
      // Secondary trigger: message.updated with error
      if (event.type === "message.updated") {
        if (info.role === "assistant" && info.error) {
          const parsed = parseAnthropicTokenLimitError(info.error)
          if (parsed) {
            pendingCompact.add(sessionID)
          }
        }
        return
      }
      
      // Fallback trigger: session.idle with pending compact
      if (event.type === "session.idle") {
        if (pendingCompact.has(sessionID)) {
          await executeCompact(...)
        }
      }
    }
  }
}
```

---

## Supporting Hooks

### Empty Message Sanitizer

**Purpose**: Prevent API errors from empty assistant messages.

**Hook**: `experimental.chat.messages.transform`

```typescript
function createEmptyMessageSanitizerHook() {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const message of output.messages) {
        if (message.info.role === "user") continue
        
        // Check if message has valid content
        if (!hasValidContent(message.parts)) {
          // Inject placeholder
          message.parts.push({
            type: "text",
            text: "[user interrupted]",
            synthetic: true,
          })
        }
        
        // Also fix empty text parts within valid messages
        for (const part of message.parts) {
          if (part.type === "text" && !part.text?.trim()) {
            part.text = "[user interrupted]"
          }
        }
      }
    }
  }
}
```

### Empty Task Response Detector

**Purpose**: Warn when Task tool returns empty output.

**Hook**: `tool.execute.after`

```typescript
function createEmptyTaskResponseDetectorHook() {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "Task") return
      
      if (output.output?.trim() === "") {
        output.output = `[Task Empty Response Warning]
        
Task invocation completed but returned no response. This indicates the agent either:
- Failed to execute properly
- Did not terminate correctly
- Returned an empty result

Note: The call has already completed - you are NOT waiting for a response.`
      }
    }
  }
}
```

### Todo Continuation Enforcer

**Purpose**: Force agents to complete pending todos before stopping.

**Hook**: `event` (session.idle)

```typescript
const CONTINUATION_PROMPT = `[SYSTEM REMINDER - TODO CONTINUATION]

Incomplete tasks remain in your todo list. Continue working on the next pending task.

- Proceed without asking for permission
- Mark each task complete when finished
- Do not stop until all tasks are done`

function createTodoContinuationEnforcer(ctx) {
  const recoveringSessions = new Set<string>()  // Coordination with session-recovery
  
  return {
    handler: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        
        // Skip if another hook is recovering this session
        if (recoveringSessions.has(sessionID)) return
        
        // Check for incomplete todos
        const todos = await ctx.client.session.todo({ path: { id: sessionID } })
        const incomplete = todos.filter(t => 
          t.status !== "completed" && t.status !== "cancelled"
        )
        
        if (incomplete.length === 0) return
        
        // 2-second countdown (allows user to interrupt)
        await showCountdown(2)
        
        // Inject continuation prompt
        await ctx.client.session.prompt({
          path: { id: sessionID },
          body: {
            parts: [{ type: "text", text: CONTINUATION_PROMPT }],
          },
        })
      }
    },
    
    // Coordination methods
    markRecovering: (sessionID) => recoveringSessions.add(sessionID),
    markRecoveryComplete: (sessionID) => recoveringSessions.delete(sessionID),
  }
}
```

### Context Window Monitor

**Purpose**: Reassure agent when context usage is high but not critical.

**Hook**: `tool.execute.after`

```typescript
const ANTHROPIC_DISPLAY_LIMIT = 1_000_000  // What UI shows
const ANTHROPIC_ACTUAL_LIMIT = 200_000     // Actual model limit
const WARNING_THRESHOLD = 0.70              // 70% of actual limit

const REMINDER = `[SYSTEM REMINDER - 1M Context Window]

You are using Anthropic Claude with 1M context window.
You have plenty of context remaining - do NOT rush or skip tasks.
Complete your work thoroughly and methodically.`

function createContextWindowMonitorHook(ctx) {
  const reminded = new Set<string>()
  
  return {
    "tool.execute.after": async (input, output) => {
      if (reminded.has(input.sessionID)) return
      
      const messages = await ctx.client.session.messages(...)
      const lastAssistant = messages.filter(m => m.role === "assistant").pop()
      
      if (lastAssistant.providerID !== "anthropic") return
      
      const tokens = lastAssistant.tokens.input + lastAssistant.tokens.cache.read
      const usage = tokens / ANTHROPIC_ACTUAL_LIMIT
      
      if (usage >= WARNING_THRESHOLD) {
        reminded.add(input.sessionID)
        output.output += `\n\n${REMINDER}\n[Context: ${usage*100}% used]`
      }
    }
  }
}
```

---

## Storage Layer

### Directory Structure

```
~/.local/share/opencode/storage/
├── message/
│   └── {sessionID}/
│       ├── {messageID_1}.json
│       ├── {messageID_2}.json
│       └── ...
└── part/
    └── {messageID}/
        ├── {partID_1}.json
        ├── {partID_2}.json
        └── ...
```

**Note**: On macOS, check both `xdg-basedir` location and `~/.local/share` fallback.

### Message Metadata Schema

```typescript
interface StoredMessageMeta {
  id: string
  sessionID: string
  role: "user" | "assistant"
  parentID?: string
  time?: {
    created: number
    completed?: number
  }
  error?: unknown
}
```

### Part Schemas

```typescript
// Text content
interface StoredTextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean  // True if injected by recovery
  ignored?: boolean
}

// Tool call/result
interface StoredToolPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: {
    status: "pending" | "running" | "completed" | "error"
    input: Record<string, unknown>
    output?: string
    error?: string
    time?: { start: number; end?: number; compacted?: number }
  }
  truncated?: boolean    // True if truncated by auto-compact
  originalSize?: number  // Original output size before truncation
}

// Thinking/reasoning
interface StoredReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning" | "thinking" | "redacted_thinking"
  text: string
}
```

### Part Type Categories

```typescript
const THINKING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"])
const META_TYPES = new Set(["step-start", "step-finish"])
const CONTENT_TYPES = new Set(["text", "tool", "tool_use", "tool_result"])
```

### Key Storage Operations

```typescript
// Find session directory (handles nested structure)
function getMessageDir(sessionID: string): string {
  const directPath = join(MESSAGE_STORAGE, sessionID)
  if (existsSync(directPath)) return directPath
  
  // Search in subdirectories
  for (const dir of readdirSync(MESSAGE_STORAGE)) {
    const sessionPath = join(MESSAGE_STORAGE, dir, sessionID)
    if (existsSync(sessionPath)) return sessionPath
  }
  return ""
}

// Read all messages for a session, sorted by creation time
function readMessages(sessionID: string): StoredMessageMeta[] {
  const messages = []
  for (const file of readdirSync(messageDir)) {
    messages.push(JSON.parse(readFileSync(join(messageDir, file))))
  }
  return messages.sort((a, b) => a.time.created - b.time.created)
}

// Read all parts for a message
function readParts(messageID: string): StoredPart[] {
  const partDir = join(PART_STORAGE, messageID)
  const parts = []
  for (const file of readdirSync(partDir)) {
    parts.push(JSON.parse(readFileSync(join(partDir, file))))
  }
  return parts
}
```

---

## Configuration

### Experimental Options

```typescript
interface ExperimentalConfig {
  // Auto-resume after successful recovery
  auto_resume?: boolean
  
  // Aggressive truncation of all tool outputs
  aggressive_truncation?: boolean
  
  // Enable preemptive compaction before overflow
  preemptive_compaction?: boolean
  
  // Threshold for preemptive compaction (default: 0.85)
  preemptive_compaction_threshold?: number
}
```

### Usage in Configuration File

```json
{
  "experimental": {
    "auto_resume": true,
    "aggressive_truncation": true
  }
}
```

---

## Implementation Notes

### Hook Coordination

Multiple hooks may respond to the same event. Use shared state to prevent conflicts:

```typescript
// In session-recovery
setOnAbortCallback(sessionID => {
  todoContinuationEnforcer.markRecovering(sessionID)
})

setOnRecoveryCompleteCallback(sessionID => {
  todoContinuationEnforcer.markRecoveryComplete(sessionID)
})
```

### Async/Non-Blocking Pattern

Recovery should not block the main event loop:

```typescript
// Fire-and-forget pattern
setTimeout(() => {
  executeCompact(sessionID, ...)
}, 300)  // Small delay to let UI update

// Auto-resume after recovery
setTimeout(async () => {
  await client.session.prompt({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: "Continue" }] },
  })
}, 500)
```

### Toast Notifications

Keep user informed throughout recovery:

```typescript
await client.tui.showToast({
  body: {
    title: "Session Recovery",
    message: "Fixing message structure...",
    variant: "warning",  // or "success", "error"
    duration: 3000,
  }
})
```

### Error Message Extraction

Handle various error object structures:

```typescript
function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error.toLowerCase()
  
  const paths = [
    error.data,
    error.error,
    error.data?.error,
    error.error?.message,
    error.message,
  ]
  
  for (const obj of paths) {
    if (typeof obj?.message === "string") {
      return obj.message.toLowerCase()
    }
  }
  
  return JSON.stringify(error).toLowerCase()
}
```

### Session Cleanup on Deletion

Always clean up state when session is deleted:

```typescript
if (event.type === "session.deleted") {
  const sessionID = event.properties.info.id
  
  pendingCompact.delete(sessionID)
  errorDataBySession.delete(sessionID)
  retryStateBySession.delete(sessionID)
  fallbackStateBySession.delete(sessionID)
  // ... all other session-keyed state
}
```

### Cooldown Periods

Prevent recovery loops:

```typescript
// Reset retry state after 5 minutes of no errors
if (Date.now() - retryState.lastAttemptTime > 300000) {
  retryState.attempt = 0
  fallbackStateBySession.delete(sessionID)
}
```

---

## Summary

The crash recovery system in oh-my-opencode is built on these principles:

1. **Detection**: Pattern matching on error messages + token counting
2. **Layered Recovery**: Multiple fallback strategies (truncate → summarize → revert)
3. **Filesystem Patching**: Direct modification of OpenCode's storage
4. **Coordination**: Shared state between hooks to prevent conflicts
5. **User Feedback**: Toast notifications throughout the process
6. **Auto-Resume**: Seamless continuation after successful recovery

The system has been battle-tested across thousands of dollars of API usage and handles the most common failure modes automatically.
