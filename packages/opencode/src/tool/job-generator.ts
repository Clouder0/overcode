import z from "zod"
import { JobRegistry } from "@/job/registry"
import { Tool } from "./tool"

export namespace JobGenerator {
  // Lazy import to avoid circular dependency issues
  // Job module imports SessionPrompt which imports ToolRegistry
  async function getJob() {
    const { Job } = await import("@/job")
    return Job
  }

  async function getJobStream() {
    const { JobStream } = await import("@/job/stream")
    return JobStream
  }

  /**
   * Helper to resolve description - handles both string and async function
   */
  async function resolveDescription(description: string | (() => Promise<string>)): Promise<string> {
    if (typeof description === "function") {
      return description()
    }
    return description
  }

  /**
   * Generate tools for a single job definition.
   * Creates: job_{name}_start, job_{name}_send (if input defined), job_{name}_read (if output defined)
   */
  export function generate(definition: JobRegistry.Definition): Tool.Info[] {
    const tools: Tool.Info[] = []
    const name = definition.name

    // Always generate start tool
    tools.push(
      Tool.define(`job_${name}_start`, async () => {
        const desc = await resolveDescription(definition.description)
        const Job = await getJob()

        return {
          description: `Start a ${name} job. ${desc}`,
          parameters: z.object({
            title: z.string().describe("Job title"),
            params: definition.params,
            wait: z.boolean().optional().describe("Wait for completion before returning"),
          }),
          async execute(params, ctx) {
            if (ctx.abort.aborted) {
              throw new Error("Operation aborted")
            }

            // Create job using Job.create (placeholder - uses registry pattern)
            const info = await createJob(Job, definition, {
              sessionID: ctx.sessionID,
              title: params.title,
              params: params.params,
            })

            if (params.wait) {
              const result = await waitForJobCompletion(Job, info.id, ctx.abort)
              ctx.metadata({
                title: `${name} job completed`,
                metadata: { jobId: result.job.id, status: result.job.status },
              })

              return {
                title: `${name} job completed`,
                metadata: { jobId: result.job.id, status: result.job.status },
                output: formatWaitResult(result),
              }
            }

            ctx.metadata({
              title: params.title,
              metadata: { jobId: info.id, status: info.status },
            })

            return {
              title: params.title,
              metadata: { jobId: info.id, status: info.status },
              output: formatJobInfo(info),
            }
          },
        }
      }),
    )

    // Generate send tool only if input schema defined
    if (definition.input) {
      const inputSchema = definition.input

      tools.push(
        Tool.define(`job_${name}_send`, async () => {
          const desc = await resolveDescription(definition.description)
          const Job = await getJob()

          return {
            description: `Send input to a ${name} job. ${desc}`,
            parameters: z.object({
              job_id: z.string().describe("Job ID"),
              input: inputSchema,
            }),
            async execute(params, ctx) {
              if (ctx.abort.aborted) {
                throw new Error("Operation aborted")
              }

              const job = await getJobForSession(Job, params.job_id, ctx.sessionID)

              if (job.type !== name) {
                throw new Error(`Job ${params.job_id} is not a ${name} job`)
              }

              if (
                job.status === "completed" ||
                job.status === "error" ||
                job.status === "canceled" ||
                job.status === "pending"
              ) {
                throw new Error(`Cannot send input to ${job.status} job`)
              }

              await Job.send({ jobID: params.job_id, input: params.input })

              ctx.metadata({
                title: `Sent input to ${name} job`,
                metadata: { jobId: params.job_id },
              })

              return {
                title: `Sent input to ${name} job`,
                metadata: { jobId: params.job_id },
                output: `Successfully sent input to job ${params.job_id}`,
              }
            },
          }
        }),
      )
    }

    // Generate read tool only if output schema defined
    if (definition.output) {
      tools.push(
        Tool.define(`job_${name}_read`, async () => {
          const desc = await resolveDescription(definition.description)
          const Job = await getJob()
          const JobStream = await getJobStream()

          return {
            description: `Read outputs from a ${name} job. ${desc}`,
            parameters: z.object({
              job_id: z.string().describe("Job ID"),
              limit: z.number().int().positive().max(200).optional().default(50).describe("Maximum frames to return"),
              after: z.string().optional().describe("Cursor: only return frames after this ID"),
            }),
            async execute(params, ctx) {
              if (ctx.abort.aborted) {
                throw new Error("Operation aborted")
              }

              const job = await getJobForSession(Job, params.job_id, ctx.sessionID)

              if (job.type !== name) {
                throw new Error(`Job ${params.job_id} is not a ${name} job`)
              }

              const frames = await JobStream.list({
                jobID: params.job_id,
                limit: params.limit,
                after: params.after,
              })

              // Filter to output frames only
              const outputFrames = frames.filter((f) => f.direction === "out")

              ctx.metadata({
                title: `${outputFrames.length} frame(s)`,
                metadata: { jobId: params.job_id, frameCount: outputFrames.length },
              })

              if (outputFrames.length === 0) {
                return {
                  title: `${name} job output`,
                  metadata: { jobId: params.job_id, frames: [] },
                  output: "No output frames found for this job.",
                }
              }

              return {
                title: `${name} job output`,
                metadata: { jobId: params.job_id, frames: outputFrames },
                output: formatFrames(outputFrames),
              }
            },
          }
        }),
      )
    }

    return tools
  }

  /**
   * Generate tools for all registered job definitions.
   */
  export function generateAll(): Tool.Info[] {
    const definitions = JobRegistry.list()
    return definitions.flatMap((d) => generate(d))
  }

  // Type for Job module to avoid importing at module level
  type JobModule = Awaited<ReturnType<typeof getJob>>
  type JobInfo = Awaited<ReturnType<JobModule["get"]>>
  type JobStreamModule = Awaited<ReturnType<typeof getJobStream>>
  type Frame = Awaited<ReturnType<JobStreamModule["list"]>>[number]

  /**
   * Helper to validate job belongs to current session.
   * Throws if job not found or belongs to different session.
   */
  async function getJobForSession(Job: JobModule, jobID: string, sessionID: string): Promise<JobInfo> {
    const job = await Job.get(jobID)
    if (job.parentSessionID !== sessionID) {
      throw new Error("Cannot access job from different session")
    }
    return job
  }

  // Helper to create a job from a definition
  async function createJob(
    Job: JobModule,
    definition: JobRegistry.Definition,
    input: { sessionID: string; title: string; params: unknown },
  ): Promise<JobInfo> {
    return Job.create({
      definition: definition.name,
      sessionID: input.sessionID,
      title: input.title,
      params: input.params,
    })
  }

  // Helper to wait for job completion using Job.wait()
  async function waitForJobCompletion(
    Job: JobModule,
    jobID: string,
    abort: AbortSignal,
  ): Promise<{ job: JobInfo; timedOut: boolean }> {
    // Check if aborted before starting
    if (abort.aborted) {
      const job = await Job.get(jobID)
      return { job, timedOut: true }
    }

    const timeout = 300000 // 5 minutes

    // Use Job.wait() which implements event-based waiting
    const result = await Job.wait({ jobID, timeout })

    // Job.wait returns { status, output?, error? }
    // We need to return { job, timedOut }
    const job = await Job.get(jobID)
    const timedOut = result.status === "running" || result.status === "pending"

    return { job, timedOut }
  }

  // Format job info for output
  function formatJobInfo(job: JobInfo): string {
    const lines = [
      `job_id: ${job.id}`,
      `type: ${job.type}`,
      `title: ${job.title}`,
      `status: ${job.status}`,
      "",
      "time:",
      `  created: ${new Date(job.time.created).toISOString()}`,
    ]

    if (job.time.started) {
      lines.push(`  started: ${new Date(job.time.started).toISOString()}`)
    }

    return lines.join("\n")
  }

  // Format wait result for output
  function formatWaitResult(result: { job: JobInfo; timedOut: boolean }): string {
    const job = result.job
    const lines: string[] = []

    if (result.timedOut) {
      lines.push(`Timeout reached. Job ${job.id} is still ${job.status}.`)
    }
    if (!result.timedOut) {
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

    return lines.join("\n")
  }

  // Format frames for output
  function formatFrames(frames: Frame[]): string {
    const lines: string[] = []

    for (const frame of frames) {
      const time = new Date(frame.time.created).toISOString()
      lines.push(`[${time}] (${frame.id})`)
      lines.push(typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data))
      lines.push("")
    }

    return lines.join("\n")
  }
}
