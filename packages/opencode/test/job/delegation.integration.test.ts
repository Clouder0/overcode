import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"

const promptState: Record<string, string | undefined> = {}
const sessionTools: Record<string, Record<string, any>> = {}
const sessionPrompts: Record<string, string[]> = {}

function reset(obj: Record<string, unknown>) {
  for (const key of Object.keys(obj)) {
    delete obj[key]
  }
}

function recordPrompt(sessionID: string, text: string) {
  const items = sessionPrompts[sessionID] ?? []
  items.push(text)
  sessionPrompts[sessionID] = items
}

function getDelay(text: string): number {
  const match = text.match(/\[delay:(\d+)\]/)
  if (!match) return 0
  return parseInt(match[1]!, 10)
}

function getFinal(text: string): string {
  const match = text.match(/\[final:([^\]]+)\]/)
  if (!match) return "Task completed"
  return match[1]!
}

function toolCtx(sessionID: string, agent: string, callID: string) {
  return {
    sessionID,
    messageID: "msg_stub",
    agent,
    abort: new AbortController().signal,
    callID,
    metadata: () => {},
  }
}

mock.module("@/session/prompt?job-delegation", () => ({
  SessionPrompt: {
    async resolvePromptParts(template: string) {
      return [{ type: "text", text: template }]
    },
    async loop() {
      return
    },
    cancel(sessionID: string) {
      promptState[sessionID] = "canceled"
    },
    setExtraTools(sessionID: string, tools: any[]) {
      sessionTools[sessionID] = {}
      for (const tool of tools) {
        sessionTools[sessionID][tool.id] = tool
      }
    },
    clearExtraTools(sessionID: string) {
      delete sessionTools[sessionID]
    },
    async prompt(input: {
      sessionID: string
      messageID?: string
      agent: string
      model?: { modelID?: string; providerID?: string }
      parts?: Array<{ type: string; text?: string }>
    }) {
      const sessionID = input.sessionID
      promptState[sessionID] = "pending"

      const parts = Array.isArray(input.parts) ? input.parts : []
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => String(p.text ?? ""))
        .join("\n")

      recordPrompt(sessionID, text)

      const ask = text.includes("[ask]")
      const ask2 = text.includes("[ask2]")
      const interactive = ask || ask2
      const delayMs = getDelay(text) || (interactive ? 75 : 0)

      const start = Date.now()
      while (Date.now() - start < delayMs) {
        if ((promptState[sessionID] as string) === "canceled") {
          throw new Error("prompt canceled")
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      if (interactive) {
        const toolInfo = sessionTools[sessionID]?.job_notify
        if (toolInfo) {
          const tool = await toolInfo.init()
          const text = ask2 ? "Need input 1" : "Need input"
          await tool.execute({ output: { type: "question", text } }, toolCtx(sessionID, input.agent, "call_notify_1"))

          if (ask2) {
            await new Promise((resolve) => setTimeout(resolve, 25))
            await tool.execute(
              { output: { type: "question", text: "Need input 2" } },
              toolCtx(sessionID, input.agent, "call_notify_2"),
            )
          }
        }

        const now = Date.now()
        return {
          info: {
            id: input.messageID ?? "msg_stub",
            role: "assistant",
            sessionID,
            time: { created: now, completed: now },
            agent: input.agent,
            modelID: input.model?.modelID ?? "test-model",
            providerID: input.model?.providerID ?? "test-provider",
          },
          parts: [
            {
              id: "prt_stub",
              sessionID,
              messageID: input.messageID ?? "msg_stub",
              type: "text",
              text: "asking",
            },
          ],
        }
      }

      const noComplete = text.includes("[no-complete]")

      const toolInfo = sessionTools[sessionID]?.job_complete
      if (toolInfo && (promptState[sessionID] as string) !== "canceled" && !noComplete) {
        const tool = await toolInfo.init()
        await tool.execute(
          { output: { type: "result", text: getFinal(text) } },
          toolCtx(sessionID, input.agent, "call_complete"),
        )
      }

      const now = Date.now()
      return {
        info: {
          id: input.messageID ?? "msg_stub",
          role: "assistant",
          sessionID,
          time: { created: now, completed: now },
          agent: input.agent,
          modelID: input.model?.modelID ?? "test-model",
          providerID: input.model?.providerID ?? "test-provider",
        },
        parts: [
          {
            id: "prt_stub",
            sessionID,
            messageID: input.messageID ?? "msg_stub",
            type: "text",
            text: "done",
          },
        ],
      }
    },
  },
}))

mock.module("@/agent/agent?job-delegation", () => ({
  Agent: {
    async get(name: string) {
      if (name === "build") {
        return {
          name,
          description: "Primary agent",
          mode: "primary",
          builtIn: true,
          tools: {},
          options: {},
          permission: {
            edit: "allow",
            bash: { "*": "allow" },
            webfetch: "allow",
            doom_loop: "ask",
            external_directory: "ask",
          },
        }
      }

      return {
        name,
        description: "Subagent",
        mode: "subagent",
        builtIn: true,
        tools: {},
        options: {},
        permission: {
          edit: "allow",
          bash: { "*": "allow" },
          webfetch: "allow",
          doom_loop: "ask",
          external_directory: "ask",
        },
      }
    },
    async list() {
      return [
        {
          name: "general",
          description: "General stub agent",
          mode: "subagent",
          builtIn: true,
          tools: {},
          options: {},
          permission: {
            edit: "allow",
            bash: { "*": "allow" },
            webfetch: "allow",
            doom_loop: "ask",
            external_directory: "ask",
          },
        },
      ]
    },
  },
}))

afterAll(() => mock.restore())

const { Job } = await import("../../src/job")
const { JobRegistry } = await import("../../src/job/registry")
const { JobGenerator } = await import("../../src/tool/job-generator")
const { JobCancelTool, JobWaitTool } = await import("../../src/tool/job")
const { JobNotification } = await import("../../src/job/notification")
const { Session } = await import("../../src/session")
const { SystemPrompt } = await import("../../src/session/system")

const projectRoot = path.join(__dirname, "../..")

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

function createCtx(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "build",
    abort: AbortSignal.any([]),
    callID: "call_test",
    metadata: () => {},
  }
}

async function getWorkerSessionID(jobID: string): Promise<string> {
  const { jobs } = await Job.get({ jobIDs: [jobID] })
  const info = jobs[0]
  const id = info?.metadata?.workerSessionID
  if (typeof id !== "string") {
    throw new Error("workerSessionID missing")
  }
  return id
}

async function getSubagentTools() {
  const def = JobRegistry.get("subagent")
  if (!def) {
    throw new Error("subagent definition missing")
  }

  const tools = JobGenerator.generate(def)
  const start = tools.find((t) => t.id === "job_subagent_start")
  const send = tools.find((t) => t.id === "job_subagent_send")
  const read = tools.find((t) => t.id === "job_subagent_read")

  if (!start || !send || !read) {
    throw new Error("missing generated subagent tools")
  }

  return { start, send, read }
}

beforeEach(() => {
  reset(promptState)
  reset(sessionTools)
  reset(sessionPrompts)
})

describe("Job delegation integration", () => {
  test("subagent prompt includes explicit tool contract", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "prompt contract", agent: "general", prompt: "[final:ok]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)

      const workerSessionID = await getWorkerSessionID(jobID)
      const promptLog = (globalThis as any).__OPENCODE_TEST_SESSION_PROMPTS__ as
        | Record<string, string[] | undefined>
        | undefined
      const prompt = promptLog?.[workerSessionID]?.[0] ?? ""

      expect(prompt).toContain("[Job Context]")
      expect(prompt).toContain("normal chat messages are NOT visible")
      expect(prompt).toContain("Communication is ONLY via these tools")
      expect(prompt).toContain("job_emit")
      expect(prompt).toContain("job_notify")
      expect(prompt).toContain("job_complete")
      expect(prompt).toContain("job_fail")
      expect(prompt).toContain("Single-return pattern")
      expect(prompt).toContain("Do not use job_notify")
      expect(prompt).toContain("job_fail({ error")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("one-shot result is captured via job_wait", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "one shot", agent: "general", prompt: "[final:hello]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      const result = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)

      const completed = result.metadata.completed.find((j: any) => j.id === jobID)
      expect(completed).toBeDefined()
      if (!completed) {
        throw new Error("missing completion result")
      }

      expect(completed.status).toBe("completed")

      const output = completed.output
      expect(typeof output).toBe("string")
      if (typeof output !== "string") {
        throw new Error("missing output")
      }
      const parsed = JSON.parse(output)
      expect(parsed.type).toBe("result")
      expect(parsed.text).toBe("hello")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("job_subagent_read includes the job_complete output frame", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start, read } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "read frames", agent: "general", prompt: "[final:world]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)

      const readTool = await read.init()
      const frames = await readTool.execute({ job_ids: [jobID], limit: 50 }, ctx)

      const job = frames.metadata.jobs[0]
      expect(job.status).toBe("completed")

      const out = (job.frames ?? []).filter((f: any) => f.direction === "out")
      expect(out.length).toBeGreaterThan(0)

      const last = out[out.length - 1]
      expect(last.notify).toBe(false)
      expect(last.data.type).toBe("result")
      expect(last.data.text).toBe("world")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("interactive notify + send flow does not leave pending JobNotification", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      JobNotification.init()

      const { start, send } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "interactive", agent: "general", prompt: "[ask]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      const first = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 10000 }, ctx)

      expect(first.metadata.notifications?.length ?? 0).toBe(1)
      expect(first.metadata.pending.length).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(JobNotification.hasPending(parent.id)).toBe(false)
      expect(JobNotification.drain(parent.id)).toEqual([])

      const sendTool = await send.init()
      await sendTool.execute(
        {
          inputs: [{ job_id: jobID, text: "[final:answer]" }],
        },
        ctx,
      )

      const second = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 10000 }, ctx)
      const completed = second.metadata.completed.find((j: any) => j.id === jobID)
      expect(completed).toBeDefined()
      if (!completed) {
        throw new Error("missing completion result")
      }

      expect(completed.status).toBe("completed")

      const output = completed.output
      expect(typeof output).toBe("string")
      if (typeof output !== "string") {
        throw new Error("missing output")
      }

      const parsed = JSON.parse(output)
      expect(parsed.text).toBe("answer")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("caller nudges callee to finalize after timeout", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start, send } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "forgot to complete", agent: "general", prompt: "[no-complete][final:ignored]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      const timedOut = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 1000 }, ctx)

      expect(timedOut.output).toContain("Pending (timeout reached):")
      expect(timedOut.output).toContain("job_subagent_send")

      const sendTool = await send.init()
      await sendTool.execute(
        {
          inputs: [{ job_id: jobID, text: "[final:ok]" }],
        },
        ctx,
      )

      const result = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)
      const completed = result.metadata.completed.find((j: any) => j.id === jobID)
      expect(completed).toBeDefined()
      if (!completed) {
        throw new Error("missing completion result")
      }
      expect(completed.status).toBe("completed")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("cancel wins over late completion", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "cancel", agent: "general", prompt: "[delay:250][final:too-late]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const cancelTool = await JobCancelTool.init()
      const canceled = await cancelTool.execute({ job_ids: [jobID] }, ctx)
      const entry = canceled.metadata.jobs[0]
      expect(entry.success).toBe(true)
      expect(entry.status).toBe("canceled")

      await new Promise((resolve) => setTimeout(resolve, 350))

      const waitTool = await JobWaitTool.init()
      const result = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)

      const completed = result.metadata.completed.find((j: any) => j.id === jobID)
      expect(completed).toBeDefined()
      if (!completed) {
        throw new Error("missing completion result")
      }

      expect(completed.status).toBe("canceled")

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("job_wait mode any returns first completed, then mode all returns both", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      const { start } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [
            { title: "fast", agent: "general", prompt: "[final:one]" },
            { title: "slow", agent: "general", prompt: "[delay:300][final:two]" },
          ],
        },
        ctx,
      )

      const job1 = started.metadata.jobs[0]!.id as string
      const job2 = started.metadata.jobs[1]!.id as string

      const waitTool = await JobWaitTool.init()
      const any = await waitTool.execute({ job_ids: [job1, job2], mode: "any", timeout: 5000 }, ctx)

      expect(any.metadata.completed.length).toBeGreaterThan(0)
      expect(any.metadata.pending.length).toBeGreaterThanOrEqual(0)

      const all = await waitTool.execute({ job_ids: [job1, job2], mode: "all", timeout: 10000 }, ctx)
      expect(all.metadata.completed.length).toBe(2)

      await Job.remove(job1)
      await Job.remove(job2)
      JobNotification.drain(parent.id)
    })
  })

  test("job_notify queues JobNotification when caller is not waiting", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      JobNotification.init()

      const { start, send } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "notify queues", agent: "general", prompt: "[ask]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(JobNotification.hasPending(parent.id)).toBe(true)
      const queued = JobNotification.drain(parent.id)
      expect(queued.length).toBe(1)
      expect(queued[0]?.jobType).toBe("subagent")
      expect(queued[0]?.jobTitle).toBe("notify queues")

      const sendTool = await send.init()
      await sendTool.execute(
        {
          inputs: [{ job_id: jobID, text: "[final:ok]" }],
        },
        ctx,
      )

      const waitTool = await JobWaitTool.init()
      await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 10000 }, ctx)

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("job_complete does not enqueue JobNotification", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      JobNotification.init()

      const { start } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "no notify", agent: "general", prompt: "[final:ok]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 5000 }, ctx)

      expect(JobNotification.hasPending(parent.id)).toBe(false)
      expect(JobNotification.drain(parent.id)).toEqual([])

      await Job.remove(jobID)
    })
  })

  test("job_wait ack does not drain later notifications", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const ctx = createCtx(parent.id)

      JobNotification.init()

      const { start, send } = await getSubagentTools()
      const startTool = await start.init()
      const started = await startTool.execute(
        {
          jobs: [{ title: "multi notify", agent: "general", prompt: "[ask2]" }],
        },
        ctx,
      )

      const jobID = started.metadata.jobs[0]!.id as string

      const waitTool = await JobWaitTool.init()
      const first = await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 10000 }, ctx)

      expect(first.metadata.notifications?.length ?? 0).toBe(1)
      expect(first.output).toContain("Need input 1")

      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(JobNotification.hasPending(parent.id)).toBe(true)
      const queued = JobNotification.drain(parent.id)
      expect(queued.length).toBe(1)
      expect(queued[0]?.frame.data).toEqual({ type: "question", text: "Need input 2" })

      const sendTool = await send.init()
      await sendTool.execute(
        {
          inputs: [{ job_id: jobID, text: "[final:done]" }],
        },
        ctx,
      )

      await waitTool.execute({ job_ids: [jobID], mode: "all", timeout: 10000 }, ctx)

      await Job.remove(jobID)
      JobNotification.drain(parent.id)
    })
  })

  test("caller system prompt includes job communication model", async () => {
    await withInstance(async () => {
      const txt = SystemPrompt.jobs()[0] ?? ""
      expect(txt).toContain("Communication model")
      expect(txt).toContain("job_complete({ output: ... })")
      expect(txt).toContain("job_notify")
      expect(txt).toContain("job_subagent_send")
    })
  })
})
