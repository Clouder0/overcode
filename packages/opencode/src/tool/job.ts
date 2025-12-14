import z from "zod"
import { Bus } from "@/bus"
import { Job } from "@/job"
import { Tool } from "./tool"

/**
 * Helper to validate job belongs to current session.
 * Throws if job not found or belongs to different session.
 */
async function getJobForSession(jobID: string, sessionID: string): Promise<Job.Info> {
  const job = await Job.get(jobID)
  if (job.parentSessionID !== sessionID) {
    throw new Error("Cannot access job from different session")
  }
  return job
}

export const JobListTool = Tool.define("job_list", {
  description: "List jobs in the current session. Returns job IDs, types, titles, and statuses.",
  parameters: z.object({
    type: z.string().optional().describe("Filter by job type (e.g., 'subagent')"),
    status: Job.Status.optional().describe("Filter by job status (pending, running, completed, error, canceled)"),
    limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of jobs to return"),
  }),
  async execute(params, ctx) {
    if (ctx.abort.aborted) {
      throw new Error("Operation aborted")
    }

    const jobs = await Job.list({
      parentSessionID: ctx.sessionID,
      type: params.type,
      status: params.status,
      limit: params.limit,
    })

    ctx.metadata({
      title: `${jobs.length} job(s)`,
      metadata: { count: jobs.length },
    })

    if (jobs.length === 0) {
      return {
        title: "No jobs",
        metadata: { count: 0 },
        output: "No jobs found in this session.",
      }
    }

    const lines = [`Found ${jobs.length} job(s):`, ""]
    for (const job of jobs) {
      lines.push(`- ${job.id}: [${job.type}] "${job.title}" (${job.status})`)
    }

    return {
      title: `${jobs.length} job(s)`,
      metadata: { count: jobs.length },
      output: lines.join("\n"),
    }
  },
})

export const JobGetTool = Tool.define("job_get", {
  description: "Get detailed information about a specific job.",
  parameters: z.object({
    job_id: z.string().describe("ID of the job to get details for"),
  }),
  async execute(params, ctx) {
    if (ctx.abort.aborted) {
      throw new Error("Operation aborted")
    }

    const job = await getJobForSession(params.job_id, ctx.sessionID)

    const lines: string[] = []
    lines.push(`job_id: ${job.id}`)
    lines.push(`type: ${job.type}`)
    lines.push(`title: ${job.title}`)
    lines.push(`status: ${job.status}`)
    if (job.parentSessionID) lines.push(`parent_session_id: ${job.parentSessionID}`)
    const workerSessionID = job.metadata?.workerSessionID as string | undefined
    if (workerSessionID) lines.push(`worker_session_id: ${workerSessionID}`)

    lines.push("time:")
    lines.push(`  created: ${new Date(job.time.created).toISOString()}`)
    if (job.time.started) lines.push(`  started: ${new Date(job.time.started).toISOString()}`)
    if (job.time.completed) lines.push(`  completed: ${new Date(job.time.completed).toISOString()}`)

    if (job.error) {
      lines.push(`error: ${job.error}`)
    }

    if (job.metadata) {
      const meta = job.metadata
      if (meta.error && typeof meta.error === "string") {
        lines.push(`metadata.error: ${meta.error}`)
      }
    }

    ctx.metadata({
      title: `Job ${job.id} (${job.status})`,
      metadata: { jobId: job.id, status: job.status },
    })

    return {
      title: `Job ${job.id} (${job.status})`,
      metadata: { job },
      output: lines.join("\n"),
    }
  },
})

export const JobCancelTool = Tool.define("job_cancel", {
  description: "Cancel a running or pending job.",
  parameters: z.object({
    job_id: z.string().describe("ID of the job to cancel"),
  }),
  async execute(params, ctx) {
    if (ctx.abort.aborted) {
      throw new Error("Operation aborted")
    }

    const job = await getJobForSession(params.job_id, ctx.sessionID)

    if (Job.isTerminal(job.status)) {
      return {
        title: `Job ${job.id}`,
        metadata: { jobId: job.id, status: job.status },
        output: `Job is already ${job.status}, cannot cancel.`,
      }
    }

    await Job.cancel(params.job_id)

    ctx.metadata({
      title: `Canceled job ${job.id}`,
      metadata: { jobId: job.id },
    })

    return {
      title: `Canceled job ${job.id}`,
      metadata: { jobId: job.id, status: "canceled" as const },
      output: `Successfully requested cancellation for job ${job.id}.`,
    }
  },
})

export const JobWaitTool = Tool.define("job_wait", {
  description:
    "Wait for a job to complete. Blocks until the job reaches a terminal state (completed, error, or canceled) or timeout.",
  parameters: z.object({
    job_id: z.string().describe("ID of the job to wait for"),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(60000)
      .describe("Timeout in milliseconds (default: 60000, max: 300000)"),
  }),
  async execute(params, ctx) {
    if (ctx.abort.aborted) {
      throw new Error("Operation aborted")
    }

    const job = await getJobForSession(params.job_id, ctx.sessionID)

    // If already terminal, return immediately
    if (Job.isTerminal(job.status)) {
      ctx.metadata({
        title: `Job ${job.id} (${job.status})`,
        metadata: { jobId: job.id, status: job.status, timedOut: false },
      })

      return {
        title: `Job ${job.id} (${job.status})`,
        metadata: { jobId: job.id, status: job.status, timedOut: false },
        output: buildWaitOutput(job, false),
      }
    }

    // Wait for job to reach terminal state
    const result = await waitForJob(params.job_id, params.timeout, ctx.abort)

    ctx.metadata({
      title: `Job ${result.job.id} (${result.job.status})`,
      metadata: { jobId: result.job.id, status: result.job.status, timedOut: result.timedOut },
    })

    return {
      title: `Job ${result.job.id} (${result.job.status})`,
      metadata: { jobId: result.job.id, status: result.job.status, timedOut: result.timedOut },
      output: buildWaitOutput(result.job, result.timedOut),
    }
  },
})

/**
 * Build the output string for job_wait result
 */
function buildWaitOutput(job: Job.Info, timedOut: boolean): string {
  const lines: string[] = []

  if (timedOut) {
    lines.push(`Timeout reached. Job ${job.id} is still ${job.status}.`)
  } else {
    lines.push(`Job ${job.id} finished with status: ${job.status}`)
  }

  lines.push("")
  lines.push(`job_id: ${job.id}`)
  lines.push(`status: ${job.status}`)
  lines.push(`type: ${job.type}`)
  lines.push(`title: ${job.title}`)

  if (job.error) {
    lines.push(`error: ${job.error}`)
  }

  if (job.metadata?.error && typeof job.metadata.error === "string") {
    lines.push(`metadata.error: ${job.metadata.error}`)
  }

  return lines.join("\n")
}

/**
 * Wait for a job to reach terminal state using Bus.subscribe
 */
async function waitForJob(
  jobID: string,
  timeout: number,
  abort: AbortSignal,
): Promise<{ job: Job.Info; timedOut: boolean }> {
  return new Promise((resolve) => {
    let resolved = false
    let unsub: (() => void) | undefined
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined

    const cleanup = () => {
      if (unsub) unsub()
      if (timeoutId) clearTimeout(timeoutId)
      if (abortHandler) abort.removeEventListener("abort", abortHandler)
    }

    const finish = async (timedOut: boolean) => {
      if (resolved) return
      resolved = true
      cleanup()

      const job = await Job.get(jobID)
      resolve({ job, timedOut })
    }

    // Subscribe to job updates
    unsub = Bus.subscribe(Job.Event.Updated, (event) => {
      if (event.properties.info.id !== jobID) return
      if (!Job.isTerminal(event.properties.info.status)) return

      finish(false)
    })

    // Set up timeout
    timeoutId = setTimeout(() => {
      finish(true)
    }, timeout)

    // Handle abort signal
    abortHandler = () => {
      finish(true)
    }
    abort.addEventListener("abort", abortHandler)
  })
}
