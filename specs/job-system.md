# Job System Design

## 1. Philosophy

A minimal, type-safe, generic job system for async, long-running, stateful work.

Core principles:

- Jobs are async background tasks belonging to sessions
- Input via async callbacks (`onInput`)
- Output via `emit` (pollable) and `notify` (push)
- Signals for system commands (`onSignal`)
- Custom jobs generate custom tools
- Subagent is a custom job, not special-cased

## 2. Data Model

### Status

```typescript
namespace Job {
  const Status = z.enum([
    "pending", // Queued, waiting to start
    "running", // Active
    "completed", // Success
    "error", // Failed
    "canceled", // Externally stopped
  ])
}
```

### Info

```typescript
namespace Job {
  const Info = z.object({
    id: z.string(),
    parentSessionID: z.string(), // Session that owns this job
    type: z.string(),
    title: z.string(),
    status: Status,
    params: z.unknown(),
    metadata: z.unknown(),
    error: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      started: z.number().optional(),
      completed: z.number().optional(),
    }),
  })
}
```

### Frame

```typescript
namespace Job {
  const Frame = z.object({
    id: z.string(),
    jobID: z.string(),
    direction: z.enum(["in", "out"]),
    notify: z.boolean(),
    data: z.unknown(),
    time: z.object({
      created: z.number(),
    }),
  })
}
```

## 3. Job Definition

```typescript
namespace Job {
  interface Definition<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType> {
    name: string
    description: string | (() => Promise<string>)
    params: TParams
    input?: TInput
    output?: TOutput
    start(ctx: JobContext<TParams, TInput, TOutput>): Promise<void>
  }

  function define<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType>(
    name: string,
    config: Omit<Definition<TParams, TInput, TOutput>, "name">,
  ): Definition<TParams, TInput, TOutput>
}
```

**Behaviors:**

- Name must match `/^[a-z][a-z0-9_]*$/`
- Duplicate name returns existing definition (supports hot reloading)
- `input` is optional - omit if job accepts no input
- `output` is optional - omit if job produces no output

## 4. Job Context

```typescript
namespace Job {
  interface JobContext<TParams extends z.ZodType, TInput extends z.ZodType, TOutput extends z.ZodType> {
    // Identity
    jobID: string
    sessionID: string
    params: z.infer<TParams>

    // Input (one-time binding, second call throws)
    onInput(callback: (input: z.infer<TInput>) => void): () => void

    // Signals (one-time binding, second call throws)
    onSignal(callback: (signal: "abort") => void): () => void

    // Output
    emit(output: z.infer<TOutput>): Promise<void>
    notify(output: z.infer<TOutput>): Promise<void>

    // Lifecycle
    complete(output?: z.infer<TOutput>): Promise<void>
    fail(error: string): Promise<void>

    // Metadata
    setMetadata(meta: Record<string, unknown>): Promise<void>
  }
}
```

**Behaviors:**

- `onInput`, `onSignal` - one-time binding, second call throws error
- `onInput` - throws if `input` schema not defined
- `emit`, `notify` - throws if `output` schema not defined
- `emit`, `notify` - no-op with warning after terminal state
- `emit`, `notify` - validates output against schema, throws if invalid
- `emit`, `notify` - throws if `maxFrames` exceeded
- `complete()` - always allowed
- `complete(output)` - throws if `output` schema not defined
- `complete(output)` - ignores `maxFrames` limit (completion always allowed)
- `complete`, `fail` - no-op after terminal state
- `setMetadata` - shallow merge
- If `start()` throws, status is set to "error" with exception message

## 5. Low-Level API

```typescript
namespace Job {
  // Lifecycle
  function create<T extends Definition<any, any, any>>(
    definition: T,
    input: {
      sessionID: string
      title: string
      params: z.infer<T["params"]>
    },
  ): Promise<Info>

  function cancel(jobID: string): Promise<void>
  function remove(jobID: string): Promise<void>

  // Communication
  function send(jobID: string, input: unknown): Promise<void>
  function read(
    jobID: string,
    options?: {
      limit?: number
      after?: string
    },
  ): Promise<Frame[]>

  // Query
  function get(jobID: string): Promise<Info>
  function list(filter?: { sessionID?: string; type?: string; status?: z.infer<typeof Status> }): Promise<Info[]>

  // Blocking
  function wait(
    jobID: string,
    options?: {
      timeout?: number
    },
  ): Promise<{
    status: z.infer<typeof Status>
    output?: Frame[]
    error?: string
  }>
}
```

**Behaviors:**

- `create` - validates params, starts immediately or queues as pending
- `create` - throws if `maxPerSession` exceeded
- `cancel` - if pending: sets status to "canceled" (no signal)
- `cancel` - if running: sends abort signal via `onSignal`, sets status to "canceled"
- `cancel` - no-op if already terminal
- `remove` - cancels first if running, then deletes job + frames
- `remove` - no-op if not found
- `send` - throws if job not found
- `send` - throws if job has no `input` schema defined
- `send` - validates input against schema, throws if invalid
- `send` - throws if job is terminal
- `send` - throws if `maxFrames` exceeded
- `read` - throws if job not found
- `read` - returns output frames only (`direction: "out"`)
- `get` - throws if not found
- `wait` - throws if job not found
- `wait` - returns immediately if job is already terminal
- `wait` - returns current state on timeout (caller checks status)
- `wait` - default timeout is 5 minutes (300000ms) if not specified

## 6. Events

```typescript
namespace Job {
  const Event = {
    Created: BusEvent<{ info: Info }>,
    Updated: BusEvent<{ info: Info }>,
    Deleted: BusEvent<{ id: string }>,
    Output: BusEvent<{ jobID: string; sessionID: string; frame: Frame }>,
    Notify: BusEvent<{ jobID: string; sessionID: string; frame: Frame }>,
  }
}
```

**Behaviors:**

- `Output` fires for all outputs (emit and notify)
- `Notify` fires only for notify calls, includes sessionID for routing

## 7. Tool Generation

### Generic Tools

| Tool         | Parameters                       | Purpose             |
| ------------ | -------------------------------- | ------------------- |
| `job_list`   | `sessionID?`, `type?`, `status?` | List jobs           |
| `job_get`    | `jobID`                          | Get job details     |
| `job_cancel` | `jobID`                          | Cancel job          |
| `job_wait`   | `jobID`, `timeout?`              | Wait for completion |

### Job-Specific Tools

| Tool               | Parameters                  | Purpose      |
| ------------------ | --------------------------- | ------------ |
| `job_{name}_start` | `title`, `params`, `wait?`  | Create job   |
| `job_{name}_send`  | `jobID`, `input`            | Send input   |
| `job_{name}_read`  | `jobID`, `limit?`, `after?` | Read outputs |

**Behaviors:**

- Tools operate on jobs within the current session only
- Skip `job_{name}_send` if `input` schema not defined
- Skip `job_{name}_read` if `output` schema not defined
- `job_{name}_start` with `wait: true` blocks until terminal, returns `{ status, output, error }`
- `job_{name}_start` with `wait: false` (default) returns `Info`

### Bridge Tools

| Tool           | Parameters | Purpose                |
| -------------- | ---------- | ---------------------- |
| `job_emit`     | `output`   | Emit output (pollable) |
| `job_notify`   | `output`   | Notify caller (push)   |
| `job_complete` | `output?`  | Mark complete          |
| `job_fail`     | `error`    | Mark failed            |

Bridge tools are injected into worker sessions by LLM-based jobs.

## 8. LLM Integration

### Tool Interface

The LLM interacts with the job system through generated tools:

**Parent agent (caller) uses:**

- `job_{name}_start` - create jobs
- `job_{name}_send` - send input to jobs (if input defined)
- `job_{name}_read` - read job outputs (if output defined)
- `job_list`, `job_get`, `job_cancel`, `job_wait` - manage jobs

**Worker agent (inside job) uses:**

- `job_emit` - report progress
- `job_notify` - ask questions, report errors
- `job_complete` - finish successfully
- `job_fail` - finish with error

### Notification Injection

When a job calls `notify()`, the notification must reach the parent agent.

**Flow:**

1. Worker calls `ctx.notify(output)`
2. System stores Frame with `notify: true`
3. System fires `Job.Event.Notify({ jobID, sessionID, frame })`
4. Session's notification handler queues the notification
5. At safe point, notifications are batched and injected as system message
6. Parent agent turn is automatically triggered (no user input needed)
7. Parent agent sees notifications and responds

**Safe points for injection:**

- After current tool execution completes
- After current agent turn completes
- Before next user message is processed

**Notification format:**

```
[Job Notification]
Type: ${job.type}
Title: ${job.title}
ID: ${job.id}

${JSON.stringify(frame.data, null, 2)}
```

**Multiple notifications batched:**

```
[Job Notification]
Type: subagent
Title: Fix bug
ID: job_abc123

{
  "type": "question",
  "text": "Should I also fix the typo?"
}

---

[Job Notification]
Type: subagent
Title: Write tests
ID: job_def456

{
  "type": "question",
  "text": "Which testing framework should I use?"
}
```

### System Prompt Guidance

Parent agent's system prompt should include:

```
You may receive notifications from background jobs. These appear as system
messages with [Job Notification] header including job type, title, and ID.
When you see these:
- For questions: Respond by sending input to the job using the job ID
- For errors: Decide whether to retry, cancel, or inform the user
- For progress: Acknowledge if relevant, or continue with other work
```

## 9. Configuration

```typescript
config.job = {
  maxConcurrent: 10,
  maxPerSession: 256,
  maxFrames: 1000,
}
```

**Behaviors:**

- `maxConcurrent` - per-session limit on running jobs, excess queued as pending
- `maxPerSession` - max total jobs per session, `create` throws if exceeded
- `maxFrames` - max frames per job (input + output), `emit`/`notify`/`send` throws if exceeded

## 10. Cleanup & Recovery

- `Job.remove()` cancels running job first, then deletes job + frames
- When session is deleted, all its jobs are canceled and removed
- Worker sessions cascade delete with parent session
- On startup: orphaned running/pending jobs marked as "error"

## 11. Subagent Job

```typescript
const SubagentJob = Job.define("subagent", {
  description: async () => {
    const agents = await Agent.list()
    return `Launch a subagent. Available: ${agents
      .filter((a) => a.mode !== "primary")
      .map((a) => a.name)
      .join(", ")}`
  },

  params: z.object({
    agent: z.string().describe("Agent to use"),
    prompt: z.string().describe("Task for the agent"),
    session_id: z.string().optional().describe("Existing session to continue"),
  }),

  input: z.object({
    text: z.string(),
  }),

  output: z.object({
    type: z.enum(["progress", "result", "question", "error"]),
    text: z.string(),
  }),

  async start(ctx) {
    const workerSessionID = ctx.params.session_id ?? (await Session.create({ parentID: ctx.sessionID })).id

    await ctx.setMetadata({ workerSessionID, agent: ctx.params.agent })

    let completed = false
    const inputQueue: Array<{ text: string }> = []
    let inputResolver: ((input: { text: string } | null) => void) | null = null

    const receive = (): Promise<{ text: string } | null> => {
      return new Promise((resolve) => {
        if (inputQueue.length > 0) {
          resolve(inputQueue.shift()!)
        } else {
          inputResolver = resolve
        }
      })
    }

    ctx.onInput((input) => {
      if (inputResolver) {
        inputResolver(input)
        inputResolver = null
      } else {
        inputQueue.push(input)
      }
    })

    ctx.onSignal((signal) => {
      if (signal === "abort") {
        Session.cancel(workerSessionID)
        completed = true
        if (inputResolver) {
          inputResolver(null)
          inputResolver = null
        }
      }
    })

    const bridgeTools = {
      job_emit: {
        description: "Send progress update to caller",
        parameters: z.object({
          type: z.enum(["progress", "result"]),
          text: z.string(),
        }),
        execute: async (params) => {
          await ctx.emit(params)
          return { success: true }
        },
      },
      job_notify: {
        description: "Notify caller immediately (for questions or errors)",
        parameters: z.object({
          type: z.enum(["question", "error"]),
          text: z.string(),
        }),
        execute: async (params) => {
          await ctx.notify(params)
          return { success: true }
        },
      },
      job_complete: {
        description: "Mark task as complete",
        parameters: z.object({
          text: z.string().optional(),
        }),
        execute: async (params) => {
          await ctx.complete(params.text ? { type: "result", text: params.text } : undefined)
          completed = true
          return { success: true }
        },
      },
      job_fail: {
        description: "Mark task as failed",
        parameters: z.object({
          error: z.string(),
        }),
        execute: async (params) => {
          await ctx.fail(params.error)
          completed = true
          return { success: true }
        },
      },
    }

    let prompt: string | null = ctx.params.prompt

    while (prompt !== null && !completed) {
      await Session.prompt({
        sessionID: workerSessionID,
        agent: ctx.params.agent,
        prompt,
        tools: bridgeTools,
      })

      if (completed) break

      const input = await receive()
      if (input === null) break
      prompt = input.text || null
    }

    if (!completed) {
      await ctx.complete()
    }
  },
})
```

## 12. Monitor Job Example

```typescript
const MonitorJob = Job.define("monitor", {
  description: "Monitor a URL for changes",

  params: z.object({
    url: z.string(),
    interval: z.number().default(60000),
  }),

  input: z.object({
    command: z.enum(["stop"]),
  }),

  output: z.object({
    type: z.enum(["change", "status", "error"]),
    message: z.string(),
  }),

  async start(ctx) {
    let running = true
    let lastContent = ""

    ctx.onSignal((signal) => {
      if (signal === "abort") {
        running = false
      }
    })

    ctx.onInput((input) => {
      if (input.command === "stop") {
        running = false
      }
    })

    while (running) {
      try {
        const response = await fetch(ctx.params.url)
        const content = await response.text()

        if (lastContent && content !== lastContent) {
          await ctx.notify({ type: "change", message: "Content changed!" })
        }

        lastContent = content
        await ctx.emit({ type: "status", message: "Checked, no change" })
      } catch (e) {
        await ctx.emit({ type: "error", message: e.message })
      }

      await Bun.sleep(ctx.params.interval)
    }

    await ctx.complete({ type: "status", message: "Monitoring stopped" })
  },
})
```

## 13. Summary

| Concept         | Implementation                                                                             |
| --------------- | ------------------------------------------------------------------------------------------ |
| Job             | Async background task, fire-and-forget start                                               |
| Definition      | `params` required, `input`/`output` optional                                               |
| Input           | `onInput` callback (one-time binding, throws if no schema)                                 |
| Signals         | `onSignal` callback (one-time binding)                                                     |
| Output          | `emit` (pollable), `notify` (push), both throw if no schema                                |
| Completion      | `complete()` always works, `complete(output)` throws if no schema, ignores maxFrames       |
| Cancellation    | `Job.cancel()` sends abort signal (if running)                                             |
| Tools           | Generic + per-definition (current session only) + bridge                                   |
| LLM Integration | Notifications batched, injected as system message with JSON data, auto-triggers agent turn |
| Subagent        | Custom job with inline input queue                                                         |
