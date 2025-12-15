import z from "zod"
import { Tool } from "./tool"

// Lazy import to avoid circular dependency issues
async function getJob() {
  const { Job } = await import("@/job")
  return Job
}

// Use literal status enum to avoid importing Job at module level
const JobStatusSchema = z.enum(["pending", "running", "completed", "error", "canceled"])
type JobStatus = z.infer<typeof JobStatusSchema>

export const JobListTool = Tool.define("job_list", async () => {
  const Job = await getJob()

  return {
    description: "List jobs in the current session. Returns job IDs, types, titles, and statuses.",
    parameters: z.object({
      type: z.string().optional().describe("Filter by job type (e.g., 'subagent')"),
      status: JobStatusSchema.optional().describe(
        "Filter by job status (pending, running, completed, error, canceled)",
      ),
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
  }
})

export const JobGetTool = Tool.define("job_get", async () => {
  const Job = await getJob()

  return {
    description: "Get detailed information about specific jobs.",
    parameters: z.object({
      job_ids: z.array(z.string()).describe("IDs of the jobs to get details for"),
    }),
    async execute(params, ctx) {
      if (ctx.abort.aborted) {
        throw new Error("Operation aborted")
      }

      // Filter to only jobs in current session
      const result = await Job.get({ jobIDs: params.job_ids })
      const sessionJobs: Array<{
        id: string
        found: boolean
        type?: string
        title?: string
        status?: JobStatus
        error?: string
        parentSessionID?: string
        lookup_error?: string
      }> = []

      for (const job of result.jobs) {
        if (!job.found) {
          sessionJobs.push(job)
          continue
        }
        // Verify job belongs to current session by checking via list
        const fullJobs = await Job.list({ parentSessionID: ctx.sessionID })
        const fullJob = fullJobs.find((j) => j.id === job.id)
        if (!fullJob) {
          sessionJobs.push({ id: job.id, found: false, lookup_error: "Access denied" })
        } else {
          sessionJobs.push({ ...job, parentSessionID: fullJob.parentSessionID })
        }
      }

      const foundCount = sessionJobs.filter((j) => j.found).length
      ctx.metadata({
        title: `${foundCount} job(s) found`,
        metadata: { count: foundCount },
      })

      const lines: string[] = []
      for (const job of sessionJobs) {
        if (!job.found) {
          lines.push(`- ${job.id}: ERROR - ${job.lookup_error}`)
          continue
        }
        lines.push(`- ${job.id}:`)
        lines.push(`  type: ${job.type}`)
        lines.push(`  title: ${job.title}`)
        lines.push(`  status: ${job.status}`)
        if (job.error) lines.push(`  error: ${job.error}`)
        lines.push("")
      }

      return {
        title: `${foundCount} job(s) found`,
        metadata: { jobs: sessionJobs },
        output: lines.join("\n"),
      }
    },
  }
})

export const JobCancelTool = Tool.define("job_cancel", async () => {
  const Job = await getJob()

  return {
    description: "Cancel running or pending jobs.",
    parameters: z.object({
      job_ids: z.array(z.string()).describe("IDs of the jobs to cancel"),
    }),
    async execute(params, ctx) {
      if (ctx.abort.aborted) {
        throw new Error("Operation aborted")
      }

      // Verify all jobs belong to current session first
      const jobCheck = await Job.get({ jobIDs: params.job_ids })
      for (const job of jobCheck.jobs) {
        if (job.found) {
          const fullJobs = await Job.list({ parentSessionID: ctx.sessionID })
          const fullJob = fullJobs.find((j) => j.id === job.id)
          if (!fullJob) {
            throw new Error(`Cannot access job ${job.id} from different session`)
          }
        }
      }

      const result = await Job.cancel({ jobIDs: params.job_ids })

      const successCount = result.jobs.filter((j) => j.success).length
      ctx.metadata({
        title: `${successCount}/${result.jobs.length} canceled`,
        metadata: { successCount, total: result.jobs.length },
      })

      const lines: string[] = []
      for (const job of result.jobs) {
        if (job.success) {
          lines.push(`- ${job.id}: ${job.status}`)
        } else {
          lines.push(`- ${job.id}: FAILED - ${job.error}`)
        }
      }

      return {
        title: `${successCount}/${result.jobs.length} canceled`,
        metadata: { jobs: result.jobs },
        output: lines.join("\n"),
      }
    },
  }
})

export const JobWaitTool = Tool.define("job_wait", async () => {
  const Job = await getJob()

  return {
    description:
      "Wait for jobs to complete. mode 'all' waits for every job (default), mode 'any' waits for first job to complete.",
    parameters: z.object({
      job_ids: z.array(z.string()).describe("IDs of the jobs to wait for"),
      mode: z.enum(["all", "any"]).default("all").describe("'all' waits for every job; 'any' waits for first"),
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

      // Verify all jobs belong to current session first
      const jobCheck = await Job.get({ jobIDs: params.job_ids })
      for (const job of jobCheck.jobs) {
        if (job.found) {
          const fullJobs = await Job.list({ parentSessionID: ctx.sessionID })
          const fullJob = fullJobs.find((j) => j.id === job.id)
          if (!fullJob) {
            throw new Error(`Cannot access job ${job.id} from different session`)
          }
        }
      }

      const result = await Job.wait({
        jobIDs: params.job_ids,
        mode: params.mode,
        timeout: params.timeout,
      })

      const completedCount = result.completed.length
      const pendingCount = result.pending.length
      const errorCount = result.errors.length

      ctx.metadata({
        title: `${completedCount} completed, ${pendingCount} pending`,
        metadata: { completedCount, pendingCount, errorCount },
      })

      const lines: string[] = []

      if (result.completed.length > 0) {
        lines.push("Completed:")
        for (const job of result.completed) {
          lines.push(`- ${job.id}: ${job.status}`)
          if (job.output) lines.push(`  output: ${job.output}`)
          if (job.error) lines.push(`  error: ${job.error}`)
        }
        lines.push("")
      }

      if (result.pending.length > 0) {
        lines.push("Pending (timeout reached):")
        for (const job of result.pending) {
          lines.push(`- ${job.id}: ${job.status}`)
        }
        lines.push("")
      }

      if (result.errors.length > 0) {
        lines.push("Errors:")
        for (const err of result.errors) {
          lines.push(`- ${err.id}: ${err.error}`)
        }
      }

      return {
        title: `${completedCount} completed, ${pendingCount} pending`,
        metadata: result,
        output: lines.join("\n"),
      }
    },
  }
})
