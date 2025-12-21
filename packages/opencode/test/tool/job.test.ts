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
  let last: { id: string; found: boolean; status?: string } | undefined

  while (Date.now() < deadline) {
    const { jobs } = await Job.get({ jobIDs: [jobID] })
    const info = jobs[0]
    last = info
    if (info?.found && (info.status === "completed" || info.status === "error" || info.status === "canceled")) {
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
      const other = await createNonSubagentJob("other", parent.id)

      const tool = await JobListTool.init()
      const ctx = createCtx(parent.id)

      // Filter for subagent jobs
      const subagentResult = await tool.execute({ limit: 50, type: "subagent" }, ctx)
      expect(subagentResult.output).toContain(job.id)
      expect(subagentResult.metadata.count).toBe(1)

      // Filter for other type
      const otherResult = await tool.execute({ limit: 50, type: "other" }, ctx)
      expect(otherResult.metadata.count).toBe(1)

      // Clean up
      await Storage.remove(["job", other.projectID, other.id]).catch(() => {})
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

      const result = await tool.execute({ job_ids: [job.id] }, ctx)

      expect(result.output).toContain(`- ${job.id}:`)
      expect(result.output).toContain("type: subagent")
      expect(result.output).toContain("title: test job")
      expect(result.output).toContain("status:")
      expect(result.metadata.jobs).toBeDefined()
      expect(result.metadata.jobs[0].id).toBe(job.id)
    })
  })

  test("returns access denied for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("Session boundary test")
      await waitForTerminalStatus(job.id)

      const tool = await JobGetTool.init()
      const ctx = createCtx("session_different")

      const result = await tool.execute({ job_ids: [job.id] }, ctx)

      expect(result.output).toContain("Access denied")
      expect(result.metadata.jobs[0].found).toBe(false)
    })
  })

  test("handles non-existent job in batch", async () => {
    await withInstance(async () => {
      const tool = await JobGetTool.init()
      const ctx = createCtx()

      const result = await tool.execute({ job_ids: ["job_nonexistent123"] }, ctx)

      expect(result.output).toContain("ERROR")
      expect(result.metadata.jobs[0].found).toBe(false)
    })
  })

  test("returns multiple job details", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      const job1 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "batch get test 1",
        params: {
          agent: "general",
          prompt: "Task 1",
        },
      })
      const job2 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "batch get test 2",
        params: {
          agent: "general",
          prompt: "Task 2",
        },
      })

      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)

      const tool = await JobGetTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: [job1.id, job2.id] }, ctx)

      expect(result.title).toBe("2 job(s) found")
      expect(result.output).toContain(job1.id)
      expect(result.output).toContain(job2.id)
      expect(result.metadata.jobs.length).toBe(2)
    })
  })

  test("handles mixed valid and invalid IDs in batch", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("mixed batch test")
      await waitForTerminalStatus(job.id)

      const tool = await JobGetTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: [job.id, "job_invalid123"] }, ctx)

      expect(result.title).toBe("1 job(s) found")
      const foundJobs = result.metadata.jobs.filter((j: { found: boolean }) => j.found)
      const notFoundJobs = result.metadata.jobs.filter((j: { found: boolean }) => !j.found)
      expect(foundJobs.length).toBe(1)
      expect(notFoundJobs.length).toBe(1)
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

      const result = await tool.execute({ job_ids: [job.id] }, ctx)

      expect(result.output).toContain(job.id)
      expect(result.metadata.jobs[0].id).toBe(job.id)

      // Wait and verify job was canceled
      await waitForTerminalStatus(job.id)
      const { jobs } = await Job.get({ jobIDs: [job.id] })
      expect(jobs[0]?.status).toBe("canceled")
    })
  })

  test("throws error for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("different session cancel test")

      const tool = await JobCancelTool.init()
      const ctx = createCtx("session_different")

      await expect(tool.execute({ job_ids: [job.id] }, ctx)).rejects.toThrow(
        `Cannot access job ${job.id} from different session`,
      )

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

      const result = await tool.execute({ job_ids: [job.id] }, ctx)

      expect(result.output).toContain(job.id)
      expect(result.metadata.jobs[0].success).toBe(true)
    })
  })

  test("handles non-existent job in batch", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const tool = await JobCancelTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: ["job_nonexistent"] }, ctx)

      expect(result.metadata.jobs[0].success).toBe(false)
      expect(result.output).toContain("FAILED")
    })
  })

  test("cancels multiple jobs", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      // Create two slow jobs
      const job1 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "batch cancel test 1",
        params: {
          agent: "general",
          prompt: "[slow-response:5000] Task 1",
        },
      })
      const job2 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "batch cancel test 2",
        params: {
          agent: "general",
          prompt: "[slow-response:5000] Task 2",
        },
      })

      // Wait for jobs to start
      await new Promise((resolve) => setTimeout(resolve, 100))

      const tool = await JobCancelTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: [job1.id, job2.id] }, ctx)

      expect(result.title).toContain("2")
      expect(result.metadata.jobs.length).toBe(2)

      // Clean up
      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)
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
      const result = await tool.execute({ job_ids: [job.id], mode: "all", timeout: 5000 }, ctx)
      const elapsed = Date.now() - startTime

      // Should return quickly (< 1 second) since job is already done
      expect(elapsed).toBeLessThan(1000)
      expect(result.output).toContain("Completed:")
      expect(result.metadata.completed.length).toBe(1)
      expect(result.metadata.completed[0].status).toBe("completed")
    })
  })

  test("waits for job to complete", async () => {
    await withInstance(async () => {
      const { job, parent } = await createTestJob("wait active test")

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: [job.id], mode: "all", timeout: 10000 }, ctx)

      // Job should complete within timeout
      expect(result.metadata.pending.length).toBe(0)
      expect(result.metadata.completed.length).toBe(1)
      expect(["completed", "error", "canceled"]).toContain(result.metadata.completed[0].status)
    })
  })

  test("times out if job takes too long", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")

      // Create a running job that won't complete (no definition to complete it)
      const runningJob = {
        id: jobID,
        projectID: project.id,
        type: "test-slow",
        title: "Running slow job",
        status: "running" as const,
        parentSessionID: parent.id,
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, jobID], runningJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const startTime = Date.now()
      const result = await tool.execute({ job_ids: [jobID], mode: "all", timeout: 1000 }, ctx)
      const elapsed = Date.now() - startTime

      // Should timeout around 1 second
      expect(elapsed).toBeGreaterThanOrEqual(900)
      expect(elapsed).toBeLessThan(2000)
      expect(result.output).toContain("Pending (timeout reached):")
      expect(result.output).toContain("job_subagent_send")
      expect(result.metadata.pending.length).toBe(1)
      // Job could be pending or running when timeout occurs
      expect(["pending", "running"]).toContain(result.metadata.pending[0].status)

      // Clean up
      await Storage.remove(["job", project.id, jobID]).catch(() => {})
    })
  })

  test("throws error for job from different session", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob("wait session boundary test")

      const tool = await JobWaitTool.init()
      const ctx = createCtx("session_different")

      await expect(tool.execute({ job_ids: [job.id], mode: "all", timeout: 5000 }, ctx)).rejects.toThrow(
        `Cannot access job ${job.id} from different session`,
      )

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })

  test("handles non-existent job", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: ["job_nonexistent"], mode: "all", timeout: 5000 }, ctx)

      expect(result.metadata.errors.length).toBe(1)
      expect(result.output).toContain("Errors:")
    })
  })

  test("mode 'all' waits for all jobs", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})

      const job1 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "wait all test 1",
        params: {
          agent: "general",
          prompt: "Task 1",
        },
      })
      const job2 = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "wait all test 2",
        params: {
          agent: "general",
          prompt: "Task 2",
        },
      })

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const result = await tool.execute({ job_ids: [job1.id, job2.id], mode: "all", timeout: 10000 }, ctx)

      // Both jobs should be completed
      expect(result.metadata.completed.length).toBe(2)
      expect(result.metadata.pending.length).toBe(0)
    })
  })

  test("mode 'any' returns when first job completes", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()

      // Create a fast job
      const fastJob = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "wait any fast",
        params: {
          agent: "general",
          prompt: "Fast task",
        },
      })

      // Create a slow pending job manually
      const slowJobID = Identifier.descending("job")
      const slowJob = {
        id: slowJobID,
        projectID: project.id,
        type: "test",
        title: "Slow job",
        status: "pending" as const,
        parentSessionID: parent.id,
        time: {
          created: now,
          updated: now,
        },
      }
      await Storage.write(["job", project.id, slowJobID], slowJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      // Wait for fast job to complete first
      await waitForTerminalStatus(fastJob.id)

      const result = await tool.execute({ job_ids: [fastJob.id, slowJobID], mode: "any", timeout: 5000 }, ctx)

      // Should return immediately since fast job is already completed
      expect(result.metadata.completed.length).toBeGreaterThanOrEqual(1)
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

      await expect(tool.execute({ job_ids: [job.id] }, ctx)).rejects.toThrow("Operation aborted")
    })
  })

  test("JobCancelTool respects abort signal", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob()

      const tool = await JobCancelTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ job_ids: [job.id] }, ctx)).rejects.toThrow("Operation aborted")

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })

  test("JobWaitTool respects abort signal", async () => {
    await withInstance(async () => {
      const { job } = await createTestJob()

      const tool = await JobWaitTool.init()
      const ctx = createAbortedCtx()

      await expect(tool.execute({ job_ids: [job.id], mode: "all", timeout: 5000 }, ctx)).rejects.toThrow(
        "Operation aborted",
      )

      // Clean up
      await waitForTerminalStatus(job.id)
    })
  })
})

describe("JobWaitTool notification handling", () => {
  test("returns immediately when notification is received", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")

      // Create a running job that won't complete on its own
      const runningJob = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Notification test job",
        status: "running" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, jobID], runningJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      // Start waiting in background
      const waitPromise = tool.execute({ job_ids: [jobID], mode: "all", timeout: 30000 }, ctx)

      // Give the wait a moment to set up subscriptions
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Import Bus and JobContext to publish a notification
      const { Bus } = await import("../../src/bus")
      const { JobContext } = await import("../../src/job/context")

      // Publish a notification for the job
      await Bus.publish(JobContext.Event.Notify, {
        jobID,
        sessionID: parent.id,
        frame: {
          id: "frame_test",
          jobID,
          direction: "out" as const,
          notify: true,
          data: { type: "question", text: "Should I continue?" },
          time: { created: Date.now() },
        },
      })

      // Wait should return immediately with the notification
      const result = await waitPromise

      expect(result.metadata.notifications).toBeDefined()
      expect(result.metadata.notifications?.length).toBe(1)
      expect(result.metadata.notifications?.[0].jobID).toBe(jobID)
      expect(result.metadata.notifications?.[0].data).toEqual({ type: "question", text: "Should I continue?" })

      // Job should be in pending since it didn't complete
      expect(result.metadata.pending.length).toBe(1)
      expect(result.metadata.pending[0].id).toBe(jobID)

      // Output should mention notification
      expect(result.output).toContain("Notifications (requires response):")
      expect(result.output).toContain("Should I continue?")
      expect(result.output).toContain("job_subagent_send")

      // Clean up
      await Storage.remove(["job", project.id, jobID]).catch(() => {})
    })
  })

  test("notification does not affect already completed jobs", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()

      // Create a completed job
      const completedJobID = Identifier.descending("job")
      const completedJob = {
        id: completedJobID,
        projectID: project.id,
        type: "subagent",
        title: "Completed job",
        status: "completed" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
          completed: now,
        },
      }
      await Storage.write(["job", project.id, completedJobID], completedJob)

      // Create a running job
      const runningJobID = Identifier.descending("job")
      const runningJob = {
        id: runningJobID,
        projectID: project.id,
        type: "subagent",
        title: "Running job",
        status: "running" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, runningJobID], runningJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      // Start waiting for both jobs
      const waitPromise = tool.execute({ job_ids: [completedJobID, runningJobID], mode: "all", timeout: 30000 }, ctx)

      // Give the wait a moment to set up subscriptions
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Import Bus and JobContext to publish a notification
      const { Bus } = await import("../../src/bus")
      const { JobContext } = await import("../../src/job/context")

      // Publish a notification for the running job
      await Bus.publish(JobContext.Event.Notify, {
        jobID: runningJobID,
        sessionID: parent.id,
        frame: {
          id: "frame_test",
          jobID: runningJobID,
          direction: "out" as const,
          notify: true,
          data: { type: "question", text: "Need help" },
          time: { created: Date.now() },
        },
      })

      const result = await waitPromise

      // Completed job should be in completed
      expect(result.metadata.completed.length).toBe(1)
      expect(result.metadata.completed[0].id).toBe(completedJobID)

      // Running job should be in pending due to notification
      expect(result.metadata.pending.length).toBe(1)
      expect(result.metadata.pending[0].id).toBe(runningJobID)

      // Notification should be present
      expect(result.metadata.notifications?.length).toBe(1)

      // Clean up
      await Storage.remove(["job", project.id, completedJobID]).catch(() => {})
      await Storage.remove(["job", project.id, runningJobID]).catch(() => {})
    })
  })

  test("title reflects notification count", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")

      const runningJob = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Test job",
        status: "running" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, jobID], runningJob)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      const waitPromise = tool.execute({ job_ids: [jobID], mode: "all", timeout: 30000 }, ctx)

      await new Promise((resolve) => setTimeout(resolve, 150))

      const { Bus } = await import("../../src/bus")
      const { JobContext } = await import("../../src/job/context")

      await Bus.publish(JobContext.Event.Notify, {
        jobID,
        sessionID: parent.id,
        frame: {
          id: "frame_test",
          jobID,
          direction: "out" as const,
          notify: true,
          data: { type: "question", text: "Test question" },
          time: { created: Date.now() },
        },
      })

      const result = await waitPromise

      // Title should indicate notification
      expect(result.title).toContain("notification")
      expect(result.title).toBe("0 completed, 1 notification(s)")

      // Clean up
      await Storage.remove(["job", project.id, jobID]).catch(() => {})
    })
  })

  test("job that completes during wait goes to completed when notification arrives", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()

      // Create two running jobs
      const job1ID = Identifier.descending("job")
      const job1 = {
        id: job1ID,
        projectID: project.id,
        type: "subagent",
        title: "Job that will complete",
        status: "running" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, job1ID], job1)

      const job2ID = Identifier.descending("job")
      const job2 = {
        id: job2ID,
        projectID: project.id,
        type: "subagent",
        title: "Job that will notify",
        status: "running" as const,
        parentSessionID: parent.id,
        params: { agent: "general", prompt: "test" },
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, job2ID], job2)

      const tool = await JobWaitTool.init()
      const ctx = createCtx(parent.id)

      // Start waiting for both jobs
      const waitPromise = tool.execute({ job_ids: [job1ID, job2ID], mode: "all", timeout: 30000 }, ctx)

      await new Promise((resolve) => setTimeout(resolve, 150))

      const { Bus } = await import("../../src/bus")
      const { JobContext } = await import("../../src/job/context")

      // First, simulate job1 completing (publish Job.Updated event)
      const completedJob1 = { ...job1, status: "completed" as const, time: { ...job1.time, completed: Date.now() } }
      await Storage.write(["job", project.id, job1ID], completedJob1)

      // Import Job to get the Event
      const { Job: JobModule } = await import("../../src/job")
      await Bus.publish(JobModule.Event.Updated, {
        info: { ...completedJob1, metadata: undefined },
      })

      // Give it a moment to process the completion
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Now job2 sends a notification
      await Bus.publish(JobContext.Event.Notify, {
        jobID: job2ID,
        sessionID: parent.id,
        frame: {
          id: "frame_test",
          jobID: job2ID,
          direction: "out" as const,
          notify: true,
          data: { type: "question", text: "Need help" },
          time: { created: Date.now() },
        },
      })

      const result = await waitPromise

      // Job1 should be in completed (it completed before notification)
      expect(result.metadata.completed.length).toBe(1)
      expect(result.metadata.completed[0].id).toBe(job1ID)
      expect(result.metadata.completed[0].status).toBe("completed")

      // Job2 should be in pending (it sent notification)
      expect(result.metadata.pending.length).toBe(1)
      expect(result.metadata.pending[0].id).toBe(job2ID)

      // Notification should be present
      expect(result.metadata.notifications?.length).toBe(1)
      expect(result.metadata.notifications?.[0].jobID).toBe(job2ID)

      // Title should reflect 1 completed and 1 notification
      expect(result.title).toBe("1 completed, 1 notification(s)")

      // Clean up
      await Storage.remove(["job", project.id, job1ID]).catch(() => {})
      await Storage.remove(["job", project.id, job2ID]).catch(() => {})
    })
  })
})
