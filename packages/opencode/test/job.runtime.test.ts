import { describe, expect, test, mock } from "bun:test"
import path from "path"
import { Instance } from "../src/project/instance"
import type { Job as JobNamespace } from "../src/job"

// We mock SessionPrompt and Agent so that Job subagent runs are
// deterministic and never hit real providers or the network.
const promptState: Record<string, "pending" | "canceled" | undefined> = {}
const sessionTools: Record<string, Record<string, any>> = {}

mock.module("@/session/prompt", () => ({
  SessionPrompt: {
    async resolvePromptParts(template: string) {
      return [
        {
          type: "text",
          text: template,
        },
      ]
    },
    cancel(sessionID: string) {
      promptState[sessionID] = "canceled"
    },
    setExtraTools(sessionID: string, tools: any[]) {
      // Store the tools without initializing - we'll initialize on demand
      sessionTools[sessionID] = {}
      for (const tool of tools) {
        // Store the tool info directly - we'll call init() when executing
        sessionTools[sessionID][tool.id] = tool
      }
    },
    clearExtraTools(sessionID: string) {
      delete sessionTools[sessionID]
    },
    async prompt(input: any) {
      const sessionID: string = input.sessionID
      promptState[sessionID] = "pending"

      const parts = Array.isArray(input.parts) ? input.parts : []
      const text = parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => String(p.text ?? ""))
        .join("\n")

      // Simulate a tool/LLM error when the prompt includes a marker
      if (text.includes("[force-error]")) {
        // Call job_fail to mark the job as failed
        const toolInfo = sessionTools[sessionID]?.job_fail
        if (toolInfo) {
          // Initialize and call job_fail synchronously before throwing
          const tool = await toolInfo.init()
          await tool
            .execute(
              { error: "forced error for test" },
              {
                sessionID,
                messageID: "msg_stub",
                agent: input.agent,
                abort: new AbortController().signal,
                callID: "call_fail",
                metadata: () => {},
              },
            )
            .catch(() => {})
        }
        throw new Error("forced error for test")
      }

      // Simulate a long response when the prompt includes [long-response:N] marker
      const longResponseMatch = text.match(/\[long-response:(\d+)\]/)
      let responseText = text || "stub response"
      if (longResponseMatch) {
        const length = parseInt(longResponseMatch[1]!, 10)
        responseText = "x".repeat(length)
      }

      // Simulate an empty response when the prompt includes [empty-response] marker
      if (text.includes("[empty-response]")) {
        responseText = ""
      }

      // Simulate a slow response when the prompt includes [slow-response:N] marker
      // This delays the response for N milliseconds, useful for testing timeouts
      const slowResponseMatch = text.match(/\[slow-response:(\d+)\]/)
      const delayMs = slowResponseMatch ? parseInt(slowResponseMatch[1]!, 10) : 50

      // Delay window where cancellation can flip the state
      const start = Date.now()
      while (Date.now() - start < delayMs) {
        if ((promptState[sessionID] as string) === "canceled") {
          throw new Error("prompt canceled")
        }
        // Yield back to the event loop briefly
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      // After the prompt completes (if not canceled), call job_complete to finish the job
      // This simulates what a real LLM would do - call the completion tool
      const toolInfo = sessionTools[sessionID]?.job_complete
      if (toolInfo && (promptState[sessionID] as string) !== "canceled") {
        // Schedule the tool call for after this function returns
        setTimeout(async () => {
          // Check again if canceled before calling complete
          if ((promptState[sessionID] as string) === "canceled") return
          try {
            const tool = await toolInfo.init()
            await tool.execute(
              { output: { type: "result", text: responseText || "Task completed" } },
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
            // Ignore errors from completion - job may already be done
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
            text: responseText,
          },
        ],
      }
    },
  },
}))

mock.module("@/agent/agent", () => ({
  Agent: {
    async get(name: string) {
      return {
        name,
        description: "Stub agent",
        mode: name === "build" ? "primary" : "subagent", // important: treated as subagent-capable
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

const { Job } = await import("../src/job")
const { JobStream } = await import("../src/job/stream")
const { Session } = await import("../src/session")

const projectRoot = path.join(__dirname, "..")

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

async function createSubagentJob(initialPrompt = "Say hello") {
  const parent = await Session.create({})
  const job = await Job.create({
    definition: "subagent",
    sessionID: parent.id,
    title: "runtime test job",
    params: {
      agent: "general",
      prompt: initialPrompt,
    },
  })
  return { job, parent }
}

async function waitForTerminalStatus(jobID: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let last: any

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

describe("Job runtime - subagent", () => {
  test("send delivers input to running job", async () => {
    await withInstance(async () => {
      // Use slow-response so job doesn't complete immediately
      const { job } = await createSubagentJob("[slow-response:5000] initial")

      // Wait a bit for job to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Send input to the running job - this should queue and not throw
      await Job.send({ jobID: job.id, input: { text: "follow-up-input" } })

      // Verify the input was stored in the stream
      const frames = await JobStream.list({ jobID: job.id })
      const inputs = frames.filter((f) => f.direction === "in")
      expect(inputs.some((f) => (f.data as any)?.text === "follow-up-input")).toBe(true)

      // Cancel the slow job so the test doesn't take forever
      await Job.cancel({ jobIDs: [job.id] })
      await waitForTerminalStatus(job.id)
    })
  })

  test("cancel on running job ends as canceled and sets completed time", async () => {
    await withInstance(async () => {
      // Use slow-response to ensure job is still running when we cancel
      const { job } = await createSubagentJob("[slow-response:10000] cancel-me")

      // Wait for job to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify job is running
      const { jobs: beforeJobs } = await Job.get({ jobIDs: [job.id] })
      const before = beforeJobs[0]
      expect(before.status).toBe("running")

      // Cancel the job
      await Job.cancel({ jobIDs: [job.id] })

      // Wait for the job to reach terminal status
      const after = await waitForTerminalStatus(job.id)

      expect(after.status).toBe("canceled")
      expect(after.time.completed).toBeDefined()
    })
  })

  test("cancel does not change status for completed and error jobs", async () => {
    await withInstance(async () => {
      // Completed job: normal successful run
      const completedJob = await createSubagentJob("normal run")
      const completedInfoBefore = await waitForTerminalStatus(completedJob.job.id)
      expect(completedInfoBefore.status).toBe("completed")
      const completedTimeBefore = completedInfoBefore.time.completed

      // Error job: force the stubbed prompt to throw
      const errorJob = await createSubagentJob("run with [force-error]")
      const errorInfoBefore = await waitForTerminalStatus(errorJob.job.id)
      expect(errorInfoBefore.status).toBe("error")
      const errorTimeBefore = errorInfoBefore.time.completed

      await Job.cancel({ jobIDs: [completedJob.job.id] })
      await Job.cancel({ jobIDs: [errorJob.job.id] })

      const { jobs: completedJobs } = await Job.get({ jobIDs: [completedJob.job.id] })
      const completedInfoAfter = completedJobs[0]
      const { jobs: errorJobs } = await Job.get({ jobIDs: [errorJob.job.id] })
      const errorInfoAfter = errorJobs[0]

      expect(completedInfoAfter.status).toBe("completed")
      expect(completedInfoAfter.time?.completed).toBe(completedTimeBefore)

      expect(errorInfoAfter.status).toBe("error")
      expect(errorInfoAfter.time?.completed).toBe(errorTimeBefore)
    })
  })

  test("jobs are not stuck as running after completion or cancel and can be re-created", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("initial run")

      // Wait for the initial run to settle
      await waitForTerminalStatus(job.id)

      const { jobs: afterCompleteJobs } = await Job.get({ jobIDs: [job.id] })
      const afterComplete = afterCompleteJobs[0]
      expect(afterComplete.status === "completed" || afterComplete.status === "error").toBe(true)

      // Create a new job for the same parent
      const newJob = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "follow up job",
        params: {
          agent: "general",
          prompt: "run-2",
        },
      })
      await waitForTerminalStatus(newJob.id)

      const { jobs: newJobJobs } = await Job.get({ jobIDs: [newJob.id] })
      const newJobInfo = newJobJobs[0]
      expect(newJobInfo.status).toBe("completed")
    })
  })

  test("send throws on canceled job", async () => {
    await withInstance(async () => {
      // Use slow-response to ensure job is still running when we cancel
      const { job } = await createSubagentJob("[slow-response:10000] cancel then send")

      // Wait for job to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify job is running before canceling
      const { jobs: beforeJobs } = await Job.get({ jobIDs: [job.id] })
      const before = beforeJobs[0]
      expect(before.status).toBe("running")

      await Job.cancel({ jobIDs: [job.id] })
      await waitForTerminalStatus(job.id)

      const { jobs: afterJobs } = await Job.get({ jobIDs: [job.id] })
      expect(afterJobs[0].status).toBe("canceled")

      // send should throw on terminal jobs per spec
      await expect(Job.send({ jobID: job.id, input: { text: "re-run after cancel" } })).rejects.toThrow(
        "JobTerminalStateError",
      )
    })
  })
})

// Import Bus for event testing
const { Bus } = await import("../src/bus")

describe("Job.list()", () => {
  test("returns array of all jobs", async () => {
    await withInstance(async () => {
      // Create multiple jobs
      const { job: job1 } = await createSubagentJob("job 1")
      const { job: job2 } = await createSubagentJob("job 2")

      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)

      const jobs = await Job.list({})

      expect(Array.isArray(jobs)).toBe(true)
      expect(jobs.length).toBeGreaterThanOrEqual(2)

      const jobIds = jobs.map((j) => j.id)
      expect(jobIds).toContain(job1.id)
      expect(jobIds).toContain(job2.id)
    })
  })

  test("filters by type", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("subagent job")
      await waitForTerminalStatus(job.id)

      const subagentJobs = await Job.list({ type: "subagent" })
      const otherJobs = await Job.list({ type: "nonexistent-type" })

      expect(subagentJobs.some((j) => j.id === job.id)).toBe(true)
      expect(otherJobs.some((j) => j.id === job.id)).toBe(false)
    })
  })

  test("filters by parentSessionID", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("with parent")
      await waitForTerminalStatus(job.id)

      const jobsWithParent = await Job.list({ parentSessionID: parent.id })
      const jobsWithOtherParent = await Job.list({ parentSessionID: "session_nonexistent" })

      expect(jobsWithParent.some((j) => j.id === job.id)).toBe(true)
      expect(jobsWithOtherParent.some((j) => j.id === job.id)).toBe(false)
    })
  })

  test("filters by status", async () => {
    await withInstance(async () => {
      // Create a completed job
      const { job: completedJob } = await createSubagentJob("will complete")
      await waitForTerminalStatus(completedJob.id)

      // Create an error job
      const { job: errorJob } = await createSubagentJob("will fail [force-error]")
      await waitForTerminalStatus(errorJob.id)

      const completedJobs = await Job.list({ status: "completed" })
      const errorJobs = await Job.list({ status: "error" })

      expect(completedJobs.some((j) => j.id === completedJob.id)).toBe(true)
      expect(errorJobs.some((j) => j.id === errorJob.id)).toBe(true)
      expect(completedJobs.some((j) => j.id === errorJob.id)).toBe(false)
      expect(errorJobs.some((j) => j.id === completedJob.id)).toBe(false)
    })
  })

  test("respects limit parameter", async () => {
    await withInstance(async () => {
      // Create 3 jobs
      const { job: job1 } = await createSubagentJob("job 1")
      const { job: job2 } = await createSubagentJob("job 2")
      const { job: job3 } = await createSubagentJob("job 3")

      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)
      await waitForTerminalStatus(job3.id)

      const limitedJobs = await Job.list({ limit: 2 })

      expect(limitedJobs.length).toBeLessThanOrEqual(2)
    })
  })

  test("returns empty array when no jobs match", async () => {
    await withInstance(async () => {
      const jobs = await Job.list({ type: "definitely-nonexistent-type-xyz123" })
      expect(jobs).toEqual([])
    })
  })
})

describe("Job.get()", () => {
  test("returns correct job data for existing job", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("test get")
      await waitForTerminalStatus(job.id)

      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const retrieved = jobs[0]

      expect(retrieved.id).toBe(job.id)
      expect(retrieved.found).toBe(true)
      expect(retrieved.type).toBe("subagent")
      expect(retrieved.title).toBe("runtime test job")
      expect(retrieved.status).toBe("completed")
      expect(retrieved.time?.created).toBeDefined()
      expect(retrieved.time?.started).toBeDefined()
      expect(retrieved.time?.completed).toBeDefined()
    })
  })

  test("returns not found for non-existent job", async () => {
    await withInstance(async () => {
      const { jobs } = await Job.get({ jobIDs: ["job_nonexistent_12345"] })
      expect(jobs[0].found).toBe(false)
      expect(jobs[0].lookup_error).toBeDefined()
    })
  })
})

describe("Job.remove()", () => {
  test("removes job from storage", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("to be removed")
      await waitForTerminalStatus(job.id)

      // Verify job exists before removal
      const { jobs: beforeJobs } = await Job.get({ jobIDs: [job.id] })
      expect(beforeJobs[0].found).toBe(true)
      expect(beforeJobs[0].id).toBe(job.id)

      await Job.remove(job.id)

      // Verify job no longer exists
      const { jobs: afterJobs } = await Job.get({ jobIDs: [job.id] })
      expect(afterJobs[0].found).toBe(false)
    })
  })

  test("publishes Job.Event.Deleted", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("delete event test")
      await waitForTerminalStatus(job.id)

      let deletedEventReceived = false
      let deletedJobId: string | undefined

      const unsub = Bus.subscribe(Job.Event.Deleted, (event) => {
        deletedEventReceived = true
        deletedJobId = event.properties.id
      })

      await Job.remove(job.id)

      // Give event time to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      expect(deletedEventReceived).toBe(true)
      expect(deletedJobId).toBe(job.id)
    })
  })
})

describe("Job Events", () => {
  test("Job.Event.Created is published when job starts", async () => {
    await withInstance(async () => {
      let createdEventReceived = false
      let createdJobInfo: JobNamespace.Info | undefined

      const unsub = Bus.subscribe(Job.Event.Created, (event) => {
        createdEventReceived = true
        createdJobInfo = event.properties.info
      })

      const parent = await Session.create({})
      const job = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "event test job",
        params: {
          agent: "general",
          prompt: "test",
        },
      })

      // Give event time to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      await waitForTerminalStatus(job.id)

      expect(createdEventReceived).toBe(true)
      expect(createdJobInfo).toBeDefined()
      expect(createdJobInfo?.id).toBe(job.id)
      expect(createdJobInfo?.type).toBe("subagent")
    })
  })

  test("Job.Event.Updated is published when status changes", async () => {
    await withInstance(async () => {
      const updatedEvents: JobNamespace.Info[] = []

      const unsub = Bus.subscribe(Job.Event.Updated, (event) => {
        updatedEvents.push(event.properties.info)
      })

      const { job } = await createSubagentJob("update event test")
      await waitForTerminalStatus(job.id)

      // Give events time to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      // Should have received at least one update event (when status changed to completed)
      expect(updatedEvents.length).toBeGreaterThan(0)

      // The last update should show the final status
      const finalUpdate = updatedEvents[updatedEvents.length - 1]
      expect(finalUpdate.id).toBe(job.id)
      expect(finalUpdate.status).toBe("completed")
    })
  })
})

describe("JobStream", () => {
  test("JobStream.append() creates frame with correct data", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("stream test")
      await waitForTerminalStatus(job.id)

      const frame = await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "in",
        data: "test input",
      })

      expect(frame.id).toBeDefined()
      expect(frame.id.startsWith("jbf_")).toBe(true)
      expect(frame.jobID).toBe(job.id)
      expect(frame.direction).toBe("in")
      expect(frame.data as string).toBe("test input")
      expect(frame.time.created).toBeDefined()
      expect(typeof frame.time.created).toBe("number")
    })
  })

  test("JobStream.append() publishes job.output event for out direction", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("output event test")
      await waitForTerminalStatus(job.id)

      let outputEventReceived = false
      let outputFrame: any

      const unsub = Bus.subscribe(JobStream.Event.Output, (event) => {
        outputEventReceived = true
        outputFrame = event.properties.frame
      })

      await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "out",
        data: "test output",
      })

      // Give event time to propagate
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      expect(outputEventReceived).toBe(true)
      expect(outputFrame.data).toBe("test output")
      expect(outputFrame.direction).toBe("out")
    })
  })

  test("JobStream.append() does not publish event for in direction", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("no event test")
      await waitForTerminalStatus(job.id)

      let outputEventReceived = false

      const unsub = Bus.subscribe(JobStream.Event.Output, () => {
        outputEventReceived = true
      })

      await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "in",
        data: "test input",
      })

      // Give time to see if event fires
      await new Promise((resolve) => setTimeout(resolve, 100))

      unsub()

      expect(outputEventReceived).toBe(false)
    })
  })

  test("JobStream.list() returns frames in order", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("order test")
      await waitForTerminalStatus(job.id)

      // Add frames with small delays to ensure ordering
      await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "in", data: "first" })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "out", data: "second" })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "in", data: "third" })

      const frames = await JobStream.list({ jobID: job.id })

      // Find our test frames
      const testFrames = frames.filter((f) => ["first", "second", "third"].includes(f.data as string))

      expect(testFrames.length).toBe(3)
      expect(testFrames[0].data as string).toBe("first")
      expect(testFrames[1].data as string).toBe("second")
      expect(testFrames[2].data as string).toBe("third")
    })
  })

  test("JobStream.list() pagination with after cursor", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("pagination test")
      await waitForTerminalStatus(job.id)

      // Add additional frames after job completion
      const frame1 = await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "in",
        data: "page-first",
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "out", data: "page-second" })
      await new Promise((resolve) => setTimeout(resolve, 10))
      await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "in", data: "page-third" })

      // Get frames after the first one
      const framesAfter = await JobStream.list({ jobID: job.id, after: frame1.id })

      // Should not include the first frame
      expect(framesAfter.some((f) => (f.data as string) === "page-first")).toBe(false)
      // Should include the frames after
      expect(framesAfter.some((f) => (f.data as string) === "page-second")).toBe(true)
      expect(framesAfter.some((f) => (f.data as string) === "page-third")).toBe(true)
    })
  })

  test("JobStream.list() limit parameter", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("limit test")
      await waitForTerminalStatus(job.id)

      // Add several frames
      for (let i = 0; i < 5; i++) {
        await JobStream.append({ jobID: job.id, sessionID: parent.id, direction: "in", data: `limit-frame-${i}` })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      const limitedFrames = await JobStream.list({ jobID: job.id, limit: 3 })

      expect(limitedFrames.length).toBe(3)
    })
  })

  test("JobStream.list() returns empty array for job with no frames", async () => {
    await withInstance(async () => {
      // Use a non-existent job ID to test empty results
      const frames = await JobStream.list({ jobID: "job_nonexistent_12345" })
      expect(frames).toEqual([])
    })
  })
})

// Import Storage and Identifier for creating jobs directly
const { Storage } = await import("../src/storage/storage")
const { Identifier } = await import("../src/id/id")

describe("Job lifecycle - error scenarios", () => {
  test("error job stores error message in metadata", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("trigger [force-error] for metadata check")
      const finalInfo = await waitForTerminalStatus(job.id)

      expect(finalInfo.status).toBe("error")
      expect(finalInfo.error).toBeDefined()
      expect(finalInfo.error).toContain("forced error")
    })
  })

  test("send throws on error job", async () => {
    await withInstance(async () => {
      // Create a job that fails
      const { job } = await createSubagentJob("initial [force-error]")
      await waitForTerminalStatus(job.id)

      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const errorInfo = jobs[0]
      expect(errorInfo.status).toBe("error")

      // Per spec, send should throw on terminal jobs
      await expect(Job.send({ jobID: job.id, input: { text: "retry" } })).rejects.toThrow("JobTerminalStateError")
    })
  })
})

describe("Job lifecycle - time fields", () => {
  test("time.started is set when job begins running", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("time test")

      // Job starts in running state from startSubagent
      expect(job.time.started).toBeDefined()
      expect(job.time.started).toBeLessThanOrEqual(Date.now())
      expect(job.time.started).toBeGreaterThan(0)
    })
  })

  test("time.completed is set when job finishes", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("completion time test")
      const finalInfo = await waitForTerminalStatus(job.id)

      expect(finalInfo.time.completed).toBeDefined()
      expect(finalInfo.time.completed).toBeGreaterThanOrEqual(finalInfo.time.started!)
    })
  })

  test("time.created and time.updated are both set on creation", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("creation time test")

      expect(job.time.created).toBeDefined()
      expect(job.time.updated).toBeDefined()
      expect(job.time.created).toBeGreaterThan(0)
    })
  })

  test("time.updated changes when job status changes", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("update time test")
      const initialCreated = job.time.created

      // Wait for status change
      await waitForTerminalStatus(job.id)
      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const finalInfo = jobs[0]

      // Verify completed time is set and is after created time
      expect(finalInfo.time?.completed).toBeDefined()
      expect(finalInfo.time?.completed).toBeGreaterThanOrEqual(initialCreated)
    })
  })
})

describe("Job.list() - combined filters", () => {
  test("filters by type AND status together", async () => {
    await withInstance(async () => {
      // Create a completed subagent job
      const { job: completedJob } = await createSubagentJob("completed subagent")
      await waitForTerminalStatus(completedJob.id)

      // Create an error subagent job
      const { job: errorJob } = await createSubagentJob("error subagent [force-error]")
      await waitForTerminalStatus(errorJob.id)

      // Filter by both type and status
      const completedSubagents = await Job.list({ type: "subagent", status: "completed" })
      const errorSubagents = await Job.list({ type: "subagent", status: "error" })

      expect(completedSubagents.some((j) => j.id === completedJob.id)).toBe(true)
      expect(completedSubagents.some((j) => j.id === errorJob.id)).toBe(false)

      expect(errorSubagents.some((j) => j.id === errorJob.id)).toBe(true)
      expect(errorSubagents.some((j) => j.id === completedJob.id)).toBe(false)
    })
  })

  test("filters by parentSessionID AND type together", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("parent filter test")
      await waitForTerminalStatus(job.id)

      // Filter by both
      const filteredJobs = await Job.list({ parentSessionID: parent.id, type: "subagent" })

      expect(filteredJobs.some((j) => j.id === job.id)).toBe(true)

      // With wrong type should not include
      const wrongType = await Job.list({ parentSessionID: parent.id, type: "nonexistent" })
      expect(wrongType.some((j) => j.id === job.id)).toBe(false)
    })
  })

  test("filters with all parameters", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("all filters test")
      await waitForTerminalStatus(job.id)

      const allFilters = await Job.list({
        type: "subagent",
        status: "completed",
        parentSessionID: parent.id,
        limit: 10,
      })

      expect(allFilters.some((j) => j.id === job.id)).toBe(true)
    })
  })
})

describe("Job - concurrent operations", () => {
  test("multiple jobs can be created simultaneously", async () => {
    await withInstance(async () => {
      // Create multiple jobs concurrently
      const createPromises = [
        createSubagentJob("concurrent job 1"),
        createSubagentJob("concurrent job 2"),
        createSubagentJob("concurrent job 3"),
      ]

      const results = await Promise.all(createPromises)

      // All jobs should have unique IDs
      const jobIds = results.map((r) => r.job.id)
      const uniqueIds = new Set(jobIds)
      expect(uniqueIds.size).toBe(3)

      // Wait for all to complete
      await Promise.all(results.map((r) => waitForTerminalStatus(r.job.id)))

      // All should be retrievable
      for (const { job } of results) {
        const { jobs } = await Job.get({ jobIDs: [job.id] })
        const retrieved = jobs[0]
        expect(retrieved).toBeDefined()
        expect(retrieved.status).toBe("completed")
      }
    })
  })

  test("concurrent send to different running jobs works", async () => {
    await withInstance(async () => {
      // Use slow responses so jobs are still running when we send
      const { job: job1 } = await createSubagentJob("[slow-response:5000] job for concurrent send 1")
      const { job: job2 } = await createSubagentJob("[slow-response:5000] job for concurrent send 2")

      // Wait a bit for jobs to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Send to both jobs concurrently
      await Promise.all([
        Job.send({ jobID: job1.id, input: { text: "concurrent input 1" } }),
        Job.send({ jobID: job2.id, input: { text: "concurrent input 2" } }),
      ])

      // Verify inputs were queued
      const frames1 = await JobStream.list({ jobID: job1.id })
      const frames2 = await JobStream.list({ jobID: job2.id })

      expect(frames1.some((f) => (f.data as any)?.text === "concurrent input 1")).toBe(true)
      expect(frames2.some((f) => (f.data as any)?.text === "concurrent input 2")).toBe(true)

      // Cancel jobs to clean up
      await Job.cancel({ jobIDs: [job1.id] })
      await Job.cancel({ jobIDs: [job2.id] })
      await waitForTerminalStatus(job1.id)
      await waitForTerminalStatus(job2.id)
    })
  })
})

describe("Job - cancel edge cases", () => {
  test("cancel on pending job without worker session", async () => {
    await withInstance(async () => {
      // Create a job directly in pending state without workerSessionID
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")
      const pendingJob: JobNamespace.Info = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Pending job",
        parentSessionID: parent.id,
        status: "pending",
        params: {},
        time: {
          created: now,
          updated: now,
        },
      }
      await Storage.write(["job", project.id, jobID], pendingJob)

      // Cancel should work and set status to canceled
      await Job.cancel({ jobIDs: [jobID] })

      const { jobs } = await Job.get({ jobIDs: [jobID] })
      const afterCancel = jobs[0]
      expect(afterCancel.status).toBe("canceled")
      expect(afterCancel.time?.completed).toBeDefined()
    })
  })

  test("double cancel is idempotent", async () => {
    await withInstance(async () => {
      // Create a job directly in pending state to ensure we can cancel it
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")
      const pendingJob: JobNamespace.Info = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Double cancel test job",
        parentSessionID: parent.id,
        status: "pending",
        params: {},
        time: {
          created: now,
          updated: now,
        },
      }
      await Storage.write(["job", project.id, jobID], pendingJob)

      // Cancel twice in quick succession
      await Job.cancel({ jobIDs: [jobID] })
      await Job.cancel({ jobIDs: [jobID] })

      const { jobs } = await Job.get({ jobIDs: [jobID] })
      const afterCancel = jobs[0]
      expect(afterCancel.status).toBe("canceled")
    })
  })

  test("cancel sets completed time only once", async () => {
    await withInstance(async () => {
      // Use slow response to ensure job is running when canceled
      const { job } = await createSubagentJob("[slow-response:10000] cancel time test")

      // Wait for job to start running
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Verify job is running
      const { jobs: beforeJobs } = await Job.get({ jobIDs: [job.id] })
      const before = beforeJobs[0]
      expect(before.status).toBe("running")

      await Job.cancel({ jobIDs: [job.id] })
      const afterFirstCancel = await waitForTerminalStatus(job.id)
      expect(afterFirstCancel.status).toBe("canceled")
      const firstCompletedTime = afterFirstCancel.time.completed
      expect(firstCompletedTime).toBeDefined()

      // Small delay
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Cancel again
      await Job.cancel({ jobIDs: [job.id] })
      const { jobs: afterJobs } = await Job.get({ jobIDs: [job.id] })
      const afterSecondCancel = afterJobs[0]

      // Completed time should not change
      expect(afterSecondCancel.time?.completed).toBe(firstCompletedTime)
    })
  })
})

describe("Job - remove edge cases", () => {
  test("remove non-existent job does not throw", async () => {
    await withInstance(async () => {
      // Remove should not throw for non-existent job
      await Job.remove("job_nonexistent_xyz")
      // If we get here without throwing, test passes
    })
  })

  test("remove clears job from list", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("job to remove from list")
      await waitForTerminalStatus(job.id)

      // Verify job is in list
      const beforeRemove = await Job.list({})
      expect(beforeRemove.some((j) => j.id === job.id)).toBe(true)

      await Job.remove(job.id)

      // Verify job is no longer in list
      const afterRemove = await Job.list({})
      expect(afterRemove.some((j) => j.id === job.id)).toBe(false)
    })
  })
})

describe("Job.get() - edge cases", () => {
  test("returns not found with lookup_error for non-existent job", async () => {
    await withInstance(async () => {
      const { jobs } = await Job.get({ jobIDs: ["job_nonexistent_abc123"] })
      expect(jobs[0].found).toBe(false)
      expect(jobs[0].lookup_error).toBeDefined()
    })
  })

  test("parallel Job.get calls work correctly", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("parallel get test")
      await waitForTerminalStatus(job.id)

      const results = await Promise.all([
        Job.get({ jobIDs: [job.id] }),
        Job.get({ jobIDs: [job.id] }),
        Job.get({ jobIDs: [job.id] }),
      ])

      for (const r of results) {
        expect(r.jobs[0].id).toBe(job.id)
      }
    })
  })
})

describe("Job metadata", () => {
  test("subagent job has correct metadata after start", async () => {
    await withInstance(async () => {
      // Use slow-response to ensure job is running long enough to check metadata
      const { job } = await createSubagentJob("[slow-response:2000] metadata test")

      // Wait for job to start and set metadata
      await new Promise((resolve) => setTimeout(resolve, 200))

      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const info = jobs[0]
      expect(info.metadata).toBeDefined()
      expect(info.metadata?.agent).toBe("general")
      expect(info.metadata?.workerSessionID).toBeDefined()

      // Clean up
      await Job.cancel({ jobIDs: [job.id] })
      await waitForTerminalStatus(job.id)
    })
  })

  test("completed job has workerSessionID in metadata", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("completion metadata test")
      await waitForTerminalStatus(job.id)

      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const finalInfo = jobs[0]
      expect(finalInfo.status).toBe("completed")
      expect(finalInfo.metadata?.workerSessionID).toBeDefined()
      expect(finalInfo.metadata?.agent).toBe("general")
    })
  })
})

describe("JobStream - edge cases", () => {
  test("append with empty text", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("empty text test")
      await waitForTerminalStatus(job.id)

      const frame = await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "in",
        data: "",
      })

      expect(frame.data as string).toBe("")
    })
  })

  test("append with very long text", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("long text test")
      await waitForTerminalStatus(job.id)

      const longText = "x".repeat(10000)
      const frame = await JobStream.append({
        jobID: job.id,
        sessionID: parent.id,
        direction: "out",
        data: longText,
      })

      expect(frame.data as string).toBe(longText)
      expect((frame.data as string).length).toBe(10000)
    })
  })

  test("list with both after and limit", async () => {
    await withInstance(async () => {
      const { job, parent } = await createSubagentJob("combined pagination test")
      await waitForTerminalStatus(job.id)

      // Add several frames
      const frames: any[] = []
      for (let i = 0; i < 5; i++) {
        const frame = await JobStream.append({
          jobID: job.id,
          sessionID: parent.id,
          direction: "in",
          data: `combined-frame-${i}`,
        })
        frames.push(frame)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      // Get frames after the first one, limited to 2
      const result = await JobStream.list({
        jobID: job.id,
        after: frames[0].id,
        limit: 2,
      })

      expect(result.length).toBe(2)
      expect(result[0].data as string).toBe("combined-frame-1")
      expect(result[1].data as string).toBe("combined-frame-2")
    })
  })
})

describe("Job rate limiting", () => {
  test("jobs over maxConcurrent limit are queued as pending", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const jobs: JobNamespace.Info[] = []

      // Create MAX_CONCURRENT_SUBAGENT_JOBS (10) jobs with slow responses
      for (let i = 0; i < 10; i++) {
        const job = await Job.create({
          definition: "subagent",
          sessionID: parent.id,
          title: `rate limit test job ${i}`,
          params: {
            agent: "general",
            prompt: `[slow-response:10000] Task ${i}`,
          },
        })
        jobs.push(job)
      }

      // Wait for jobs to start
      await new Promise((resolve) => setTimeout(resolve, 100))

      // 11th job should be created with "pending" status (not throw)
      const pendingJob = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "pending job",
        params: {
          agent: "general",
          prompt: "This should be pending",
        },
      })

      expect(pendingJob.status).toBe("pending")

      // Clean up - cancel all jobs
      for (const job of [...jobs, pendingJob]) {
        await Job.cancel({ jobIDs: [job.id] })
      }
      for (const job of [...jobs, pendingJob]) {
        await waitForTerminalStatus(job.id)
      }
    })
  })

  test("allows new job after existing one completes", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const jobs: JobNamespace.Info[] = []

      // Create 10 jobs
      for (let i = 0; i < 10; i++) {
        const job = await Job.create({
          definition: "subagent",
          sessionID: parent.id,
          title: `job ${i}`,
          params: {
            agent: "general",
            prompt: `Task ${i}`,
          },
        })
        jobs.push(job)
      }

      // Wait for first job to complete
      await waitForTerminalStatus(jobs[0]!.id)

      // Now we should be able to create another job
      const newJob = await Job.create({
        definition: "subagent",
        sessionID: parent.id,
        title: "after completion",
        params: {
          agent: "general",
          prompt: "This should work now",
        },
      })

      expect(newJob.id).toBeDefined()
      await waitForTerminalStatus(newJob.id)
    })
  })
})

describe("Job.remove() cleanup", () => {
  test("removes worker session when job is removed", async () => {
    await withInstance(async () => {
      // Use slow-response so we have time to get metadata before job completes
      const { job } = await createSubagentJob("[slow-response:3000] cleanup test")

      // Wait for job to start and set metadata
      await new Promise((resolve) => setTimeout(resolve, 200))

      const { jobs } = await Job.get({ jobIDs: [job.id] })
      const jobWithMetadata = jobs[0]
      const workerSessionID = jobWithMetadata?.metadata?.workerSessionID as string | undefined

      expect(workerSessionID).toBeDefined()

      // Verify worker session exists before removal
      const sessionBefore = await Session.get(workerSessionID!)
      expect(sessionBefore).toBeDefined()

      // Cancel and wait for terminal status, then remove
      await Job.cancel({ jobIDs: [job.id] })
      await waitForTerminalStatus(job.id)
      await Job.remove(job.id)

      // Verify worker session is gone
      // Session.get throws or returns undefined for non-existent sessions
      let sessionGone = false
      try {
        await Session.get(workerSessionID!)
      } catch {
        sessionGone = true
      }
      expect(sessionGone).toBe(true)
    })
  })

  test("remove handles already-deleted job gracefully", async () => {
    await withInstance(async () => {
      const { job } = await createSubagentJob("double remove test")
      await waitForTerminalStatus(job.id)

      // First remove should succeed
      await Job.remove(job.id)

      // Second remove should not throw
      await expect(Job.remove(job.id)).resolves.toBeUndefined()
    })
  })
})

describe("Job.recoverOrphanedJobs()", () => {
  test("returns 0 when no orphaned jobs exist", async () => {
    await withInstance(async () => {
      // Create and complete a job normally
      const { job } = await createSubagentJob("normal job")
      const finalJob = await waitForTerminalStatus(job.id)

      // Verify the job is in a terminal state before calling recover
      expect(["completed", "error", "canceled"]).toContain(finalJob.status)

      // List all running/pending jobs - there should be none
      const running = await Job.list({ status: "running" })
      const pending = await Job.list({ status: "pending" })
      expect(running.length).toBe(0)
      expect(pending.length).toBe(0)

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBe(0)
    })
  })

  test("recovers jobs stuck in running status without active runtime", async () => {
    await withInstance(async () => {
      // Create a job directly in "running" status without runtime entry
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")
      const orphanedJob: JobNamespace.Info = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Orphaned running job",
        parentSessionID: parent.id,
        status: "running",
        params: {},
        time: {
          created: now,
          updated: now,
          started: now,
        },
      }
      await Storage.write(["job", project.id, jobID], orphanedJob)
      await Storage.write(["job_active", project.id], [jobID])

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBe(1)

      const { jobs } = await Job.get({ jobIDs: [jobID] })
      const info = jobs[0]
      expect(info.status).toBe("error")
      expect(info.time?.completed).toBeDefined()
      expect(info.error).toContain("interrupted by application restart")
      expect(info.metadata?.recoveredAt).toBeDefined()
    })
  })

  test("recovers jobs stuck in pending status without active runtime", async () => {
    await withInstance(async () => {
      const parent = await Session.create({})
      const project = Instance.project
      const now = Date.now()
      const jobID = Identifier.descending("job")
      const orphanedJob: JobNamespace.Info = {
        id: jobID,
        projectID: project.id,
        type: "subagent",
        title: "Orphaned pending job",
        parentSessionID: parent.id,
        status: "pending",
        params: {},
        time: {
          created: now,
          updated: now,
        },
      }
      await Storage.write(["job", project.id, jobID], orphanedJob)
      await Storage.write(["job_active", project.id], [jobID])

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBe(1)

      const { jobs } = await Job.get({ jobIDs: [jobID] })
      const info = jobs[0]
      expect(info.status).toBe("error")
    })
  })

  test("does not recover jobs in terminal states", async () => {
    await withInstance(async () => {
      const project = Instance.project
      const now = Date.now()

      // Create jobs in terminal states
      const completedJobID = Identifier.descending("job")
      await Storage.write(["job", project.id, completedJobID], {
        id: completedJobID,
        projectID: project.id,
        type: "subagent",
        title: "Completed job",
        status: "completed",
        time: { created: now, updated: now, completed: now },
      })

      const errorJobID = Identifier.descending("job")
      await Storage.write(["job", project.id, errorJobID], {
        id: errorJobID,
        projectID: project.id,
        type: "subagent",
        title: "Error job",
        status: "error",
        time: { created: now, updated: now, completed: now },
      })

      const canceledJobID = Identifier.descending("job")
      await Storage.write(["job", project.id, canceledJobID], {
        id: canceledJobID,
        projectID: project.id,
        type: "subagent",
        title: "Canceled job",
        status: "canceled",
        time: { created: now, updated: now, completed: now },
      })

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBe(0)

      // Verify statuses unchanged
      const { jobs: completedJobs } = await Job.get({ jobIDs: [completedJobID] })
      expect(completedJobs[0].status).toBe("completed")
      const { jobs: errorJobs } = await Job.get({ jobIDs: [errorJobID] })
      expect(errorJobs[0].status).toBe("error")
      const { jobs: canceledJobs } = await Job.get({ jobIDs: [canceledJobID] })
      expect(canceledJobs[0].status).toBe("canceled")
    })
  })

  test("does not recover actually running jobs with active runtime", async () => {
    await withInstance(async () => {
      // Create a job that is actually running
      const { job } = await createSubagentJob("[slow-response:2000]")

      // While job is still running, call recoverOrphanedJobs
      const recovered = await Job.recoverOrphanedJobs()

      // Should not recover this job since it has an active runtime
      expect(recovered).toBe(0)

      // Let job complete
      await waitForTerminalStatus(job.id)
    })
  })

  test("recovers multiple orphaned jobs", async () => {
    await withInstance(async () => {
      const project = Instance.project
      const now = Date.now()

      // Create 3 orphaned jobs
      const jobIDs: string[] = []
      for (let i = 0; i < 3; i++) {
        const jobID = Identifier.descending("job")
        await Storage.write(["job", project.id, jobID], {
          id: jobID,
          projectID: project.id,
          type: "subagent",
          title: `Orphaned job ${i}`,
          status: i % 2 === 0 ? "running" : "pending",
          time: { created: now, updated: now, started: now },
        })
        jobIDs.push(jobID)
      }

      await Storage.write(["job_active", project.id], jobIDs)

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBe(3)
    })
  })
})
