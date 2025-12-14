import { describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"

// Track prompt state for cancellation tests
const promptState: Record<string, "pending" | "canceled"> = {}
const sessionTools: Record<string, Record<string, any>> = {}

// Mock SessionPrompt for deterministic behavior
mock.module("@/session/prompt", () => ({
  SessionPrompt: {
    async resolvePromptParts(template: string) {
      return [{ type: "text", text: template }]
    },
    cancel(sessionID: string) {
      promptState[sessionID] = "canceled"
    },
    setExtraTools(sessionID: string, tools: any[]) {
      // Store the tools without initializing - we'll initialize on demand
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
      const sessionID: string = input.sessionID
      promptState[sessionID] = "pending"

      const parts = Array.isArray(input.parts) ? input.parts : []
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => String(p.text ?? ""))
        .join("\n")

      // Simulate a slow response when the prompt includes [slow-response:N] marker
      const slowResponseMatch = text.match(/\[slow-response:(\d+)\]/)
      const delayMs = slowResponseMatch ? parseInt(slowResponseMatch[1]!, 10) : 10

      // Delay window where cancellation can flip the state
      const start = Date.now()
      while (Date.now() - start < delayMs) {
        if ((promptState[sessionID] as string) === "canceled") {
          throw new Error("prompt canceled")
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      // After the prompt completes (if not canceled), call job_complete to finish the job
      const toolInfo = sessionTools[sessionID]?.job_complete
      if (toolInfo && (promptState[sessionID] as string) !== "canceled") {
        setTimeout(async () => {
          if ((promptState[sessionID] as string) === "canceled") return
          try {
            const tool = await toolInfo.init()
            await tool.execute(
              { output: { type: "result", text: text || "Task completed" } },
              {
                sessionID,
                messageID: "msg_stub",
                agent: input.agent,
                abort: new AbortController().signal,
                callID: "call_complete",
                metadata: () => {},
              },
            )
          } catch {
            // Ignore errors from completion
          }
        }, 10)
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
            text: text || "stub response",
          },
        ],
      }
    },
  },
}))

// Mock Agent to provide controlled test agents
mock.module("@/agent/agent", () => ({
  Agent: {
    async get(name: string) {
      if (name === "invalid-agent" || name === "nonexistent") {
        return undefined
      }
      return {
        name,
        description: "Stub agent",
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

// Import modules after mocks are set up
const { Job } = await import("../../src/job")
const { Session } = await import("../../src/session")
const { Storage } = await import("../../src/storage/storage")
const { Identifier } = await import("../../src/id/id")

// Import the tools
const { JobListTool, JobGetTool, JobCancelTool, JobWaitTool } = await import("../../src/tool/job")

const projectRoot = path.join(__dirname, "../..")

// Helper to run code within Instance context
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

// Helper to create a basic tool context
function createCtx(sessionID?: string) {
  return {
    sessionID: sessionID ?? `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    messageID: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    agent: "build",
    abort: AbortSignal.any([]),
    callID: "call_test",
    metadata: () => {},
  }
}

// Helper to create a subagent job for testing
async function createTestJob(prompt = "Test job") {
  const parent = await Session.create({})
  const job = await Job.create({
    definition: "subagent",
    sessionID: parent.id,
    title: "test job",
    params: {
      agent: "general",
      prompt,
    },
  })
  return { job, parent }
}

// Helper to wait for job terminal status
async function waitForTerminalStatus(jobID: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<typeof Job.get>> | undefined

  while (Date.now() < deadline) {
    const info = await Job.get(jobID)
    last = info
    if (info.status === "completed" || info.status === "error" || info.status === "canceled") {
      return info
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  if (!last) throw new Error("Job did not reach a terminal status in time")
  return last
}

// Helper to create a non-subagent job directly
async function createNonSubagentJob(type: string, parentSessionID?: string) {
  const project = Instance.project
  const now = Date.now()
  const jobID = Identifier.descending("job")
  const job = {
    id: jobID,
    projectID: project.id,
    type,
    title: `${type} job`,
    parentSessionID,
    status: "pending" as const,
    params: {},
    time: {
      created: now,
      updated: now,
    },
  }
  await Storage.write(["job", project.id, jobID], job)
  return job
}

describe("JobListTool", () => {
  test("returns empty list when no jobs exist", async () => {
    await withInstance(async () => {
      const tool = await JobListTool.init()
      const ctx = createCtx()

      const result = await tool.execute({ limit: 50 }, ctx)

      expect(result.output).toContain("No jobs found")
      expect(result.metadata.count).toBe(0)
    })
  })

  test("lists jobs in current session", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      // Create two jobs
      const job1 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "list test job 1",
        params: {
          agent: "general",
          prompt: "Task 1",
        },
      })
      const job2 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "list test job 2",
        params: {
          agent: "general",
          prompt: "Task 2",
        },
      })

      const tool = await JobListTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ limit: 50 }, ctx)

      expect(result.output).toContain("Found 2 job(s)")
      expect(result.output).toContain(job1.id)
      expect(result.output).toContain(job2.id)
      expect(result.metadata.count).toBe(2)

      // Clean up
      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)
    })
  })

  test("filters by type", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      // Create a subagent job
      const job = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "type filter test",
        params: {
          agent: "general",
          prompt: "Task",
        },
      })
      await waitForTerminalStatus(job.id)

      // Create a non-subagent job
      await createNonSubagentJob("other", parent.id)

      const tool = await JobListTool.init()
      const ctx = createCtx(parent.id)

      // Filter for subagent jobs
      const subagentResult = await tool.execute({ limit: 50, type: "subagent" }, ctx)
      expect(subagentResult.output).toContain(job.id)
      expect(subagentResult.metadata.count).toBe(1)

      // Filter for other type
      const otherResult = await tool.execute({ limit: 50, type: "other" }, ctx)
      expect(otherResult.metadata.count).toBe(1)
    })
  })

  test("filters by status", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      // Create a job and wait for it to complete
      const job = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "status filter test",
        params: {
          agent: "general",
          prompt: "Task",
        },
      })
      await waitForTerminalStatus(job.id)

      const tool = await JobListTool.init()
      const ctx = createCtx(parent.id)

      // Filter for running jobs (should be empty now)
      const runningResult = await tool.execute({ limit: 50, status: "running" }, ctx)
      expect(runningResult.output).toContain("No jobs found")

      // Filter for completed jobs
      const completedResult = await tool.execute({ limit: 50, status: "completed" }, ctx)
      expect(completedResult.output).toContain(job.id)
    })
  })

  test("respects limit parameter", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      // Create 3 jobs
      for (let i = 0; i < 3; i++) {
        await Job.create({
          definition: "subagent",
          sessionID: parent.id,
          title: `limit test job ${i}`,
          params: {
            agent: "general",
            prompt: `Task ${i}`,
          },
        })
      }

      const tool = await JobListTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ limit: 2 }, ctx)

      expect(result.metadata.count).toBe(2)
      expect(result.output).toContain("Found 2 job(s)")
    })
  })

  test("only returns jobs from current session", async () => {
    await withInstance(async () => {
      const parent1 = await Session.create({})
      const parent2 = await Session.create({})

      // Create job in parent1
      const job1 = await Job.create({
        definition: "subagent",
        sessionID: parent1.id,
        title: "session boundary test",
        params: {
          agent: "general",
          prompt: "Task",
        },
      })
      await waitForTerminalStatus(job1.id)

      const tool = await JobListTool.init()

      // List from parent2's context - should not see parent1's jobs
      const ctx = createCtx(parent2.id)
      const result = await tool.execute({ limit: 50 }, ctx)

      expect(result.output).toContain("No jobs found")
      expect(result.metadata.count).toBe(0)
    })
  })
})

describe("JobGetTool", () => {
  test("returns job details", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("Get test job")
      await waitForTerminalStatus(job.id)

      const tool = await JobGetTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_id: job.id }, ctx)

      expect(result.output).toContain(`job_id: ${job.id}`)
      expect(result.output).toContain("type: subagent")
      expect(result.output).toContain("title: test job")
      expect(result.output).toContain("status:")
      expect(result.output).toContain("time:")
      expect(result.metadata.job).toBeDefined()
      expect(result.metadata.job.id).toBe(job.id)
    })
  })

  test("throws error for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("Session boundary test")
      await waitForTerminalStatus(job.id)

      const tool = await JobGetTool.init()
      const ctx = createCtx("session_different")

      await expect(tool.execute({ job_id: job.id }, ctx)).rejects.toThrow("Cannot access job from different session")
    })
  })

  test("throws error for non-existent job", async () => {
    await withInstance(async () => {
      const tool = await JobGetTool.init()
      const ctx = createCtx()

      await expect(tool.execute({ job_id: "job_nonexistent123" }, ctx)).rejects.toThrow()
    })
  })
})

describe("JobCancelTool", () => {
  test("cancels a running job successfully", async () => {
    await withInstance(async () => {
      // Use slow-response to ensure job is still running when we cancel
      const { job, parent } = await createTestJob("[slow-response:5000] cancel test")

      // Wait for job to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      const tool = await JobCancelTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_id: job.id }, ctx)

      expect(result.output).toContain("Successfully requested cancellation")
      expect(result.metadata.jobId).toBe(job.id)

      // Wait and verify job was canceled
      await waitForTerminalStatus(job.id)
      const updatedJob = await Job.get(job.id)
      expect(updatedJob.status).toBe("canceled")
    })
  })

  test("throws error for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("different session cancel test")

      const tool = await JobCancelTool.init()
      const ctx = createCtx("session_different")

      await expect(tool.execute({ job_id: job.id }, ctx)).rejects.toThrow("Cannot access job from different session")

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })

  test("handles already completed job gracefully", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("completed job test")
      await waitForTerminalStatus(job.id)

      const tool = await JobCancelTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_id: job.id }, ctx)

      expect(result.output).toContain("already completed")
      expect(result.metadata.status).toBe("completed")
    })
  })

  test("throws error for non-existent job", async () => {
    await withInstance(async () => {
      const tool = await JobCancelTool.init()
      const ctx = createCtx()

      await expect(tool.execute({ job_id: "job_nonexistent" }, ctx)).rejects.toThrow()
    })
  })
})

describe("JobWaitTool", () => {
  test("returns immediately for already completed job", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("wait completed test")
      await waitForTerminalStatus(job.id)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const startTime = Date.now()
      const result = await tool.execute({ job_id: job.id, timeout: 5000 }, ctx)
      const elapsed = Date.now() - startTime

      // Should return quickly (< 1 second) since job is already done
      expect(elapsed).toBeLessThan(1000)
      expect(result.output).toContain("finished with status: completed")
      expect(result.metadata.timedOut).toBe(false)
      expect(result.metadata.status).toBe("completed")
    })
  })

  test("waits for job to complete", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("wait active test")

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_id: job.id, timeout: 10000 }, ctx)

      // Job should complete within timeout
      expect(result.metadata.timedOut).toBe(false)
      expect(["completed", "error", "canceled"]).toContain(result.metadata.status)
    })
  })

  test("times out if job takes too long", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")

      // Create a pending job that won't complete
      const pendingJob = {
        id: jobID,
        projectID: project.id,
        type: "test",
        title: "Pending job",
        status: "pending" as const,
        parentSessionID: parent.id,
        time: {
          created: now,
          updated: now,
        },
      }
      await Storage.write(["job", project.id, jobID], pendingJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const startTime = Date.now()
      const result = await tool.execute({ job_id: jobID, timeout: 1000 }, ctx)
      const elapsed = Date.now() - startTime

      // Should timeout around 1 second
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(2000)
      expect(result.output).toContain("Timeout reached")
      expect(result.metadata.timedOut).toBe(true)
      expect(result.metadata.status).toBe("pending")
    })
  })

  test("throws error for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("wait session boundary test")

      const tool = await JobWaitTool.init()
      const ctx = createCtx("session_different")

      await expect(tool.execute({ job_id: job.id, timeout: 5000 }, ctx)).rejects.toThrow(
        "Cannot access job from different session",
      )

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })

  test("throws error for non-existent job", async () => {
    await withInstance(async () => {
      const tool = await JobWaitTool.init()
      const ctx = createCtx()

      await expect(tool.execute({ job_id: "job_nonexistent", timeout: 5000 }, ctx)).rejects.toThrow()
    })
  })
})

describe("Abort signal handling", () => {
  function createAbortedCtx(sessionID?: string) {
    const abortController = new AbortController()
    abortController.abort()
    return {
      sessionID: sessionID ?? `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      messageID: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      agent: "build",
      abort: abortController.signal,
      callID: "call_test",
      metadata: () => {},
    }
  }

  test("JobListTool respects abort signal", async () => {
    await withInstance(async () => {
      const tool = await JobListTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ limit: 50 }, ctx)).rejects.toThrow("Operation aborted")
    })
  })

  test("JobGetTool respects abort signal", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob()
      await waitForTerminalStatus(job.id)

      const tool = await JobGetTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ job_id: job.id }, ctx)).rejects.toThrow("Operation aborted")
    })
  })

  test("JobCancelTool respects abort signal", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob()

      const tool = await JobCancelTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ job_id: job.id }, ctx)).rejects.toThrow("Operation aborted")

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })

  test("JobWaitTool respects abort signal", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob()

      const tool = await JobWaitTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ job_id: job.id, timeout: 5000 }, ctx)).rejects.toThrow("Operation aborted")

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })
})
