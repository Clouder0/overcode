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

        // Create a schema for individual job that merges title with params
        const jobSchema = z
          .object({
            title: z.string().describe("Job title"),
          })
          .and(definition.params)

        return {
          description: `Start one or more ${name} jobs. ${desc}`,
          parameters: z.object({
            jobs: z.array(jobSchema).describe("Jobs to start"),
          }),
          async execute(params, ctx) {
            if (ctx.abort.aborted) {
              throw new Error("Operation aborted")
            }

            const jobsToCreate = params.jobs.map((job) => {
              const { title, ...rest } = job as { title: string; [key: string]: unknown }
              return { title, params: rest }
            })

            const result = await Job.createBatch({
              definition: definition.name,
              sessionID: ctx.sessionID,
              jobs: jobsToCreate,
            })

            const successCount = result.jobs.filter((j) => j.id).length
            const lines = result.jobs.map((job) =>
              job.id ? `- ${job.id}: ${job.title} (${job.status})` : `- FAILED: ${job.title} - ${job.error}`,
            )

            return {
              title: `${successCount}/${result.jobs.length} jobs`,
              metadata: { jobs: result.jobs },
              output: lines.join("\n"),
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

          // Create schema that merges job_id with input fields
          const itemSchema = z
            .object({
              job_id: z.string().describe("Job ID"),
            })
            .and(inputSchema)

          return {
            description: `Send input to one or more ${name} jobs. ${desc}`,
            parameters: z.object({
              inputs: z.array(itemSchema).describe("Inputs to send"),
            }),
            async execute(params, ctx) {
              if (ctx.abort.aborted) {
                throw new Error("Operation aborted")
              }

              // Verify jobs belong to current session
              const jobIDs = params.inputs.map((i) => (i as { job_id: string }).job_id)
              const sessionJobs = await Job.list({ parentSessionID: ctx.sessionID })
              const sessionJobIDs = new Set(sessionJobs.map((j) => j.id))

              for (const jobID of jobIDs) {
                if (!sessionJobIDs.has(jobID)) {
                  throw new Error(`Cannot access job ${jobID} from different session`)
                }
              }

              // Transform flattened inputs
              const inputsToSend = params.inputs.map((item) => {
                const { job_id, ...rest } = item as { job_id: string; [key: string]: unknown }
                return { jobID: job_id, input: rest }
              })

              const result = await Job.sendBatch({ inputs: inputsToSend })

              const successCount = result.jobs.filter((j) => j.success).length
              ctx.metadata({
                title: `${successCount}/${result.jobs.length} sent`,
                metadata: { successCount },
              })

              const lines: string[] = []
              for (const job of result.jobs) {
                if (job.success) {
                  lines.push(`- ${job.job_id}: sent`)
                } else {
                  lines.push(`- ${job.job_id}: FAILED - ${job.error}`)
                }
              }

              return {
                title: `${successCount}/${result.jobs.length} sent`,
                metadata: { jobs: result.jobs },
                output: lines.join("\n"),
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

          return {
            description: `Read outputs from one or more ${name} jobs. ${desc}`,
            parameters: z.object({
              job_ids: z.array(z.string()).describe("Job IDs to read from"),
              limit: z.number().int().positive().max(65536).optional().default(50).describe("Maximum frames per job"),
            }),
            async execute(params, ctx) {
              if (ctx.abort.aborted) {
                throw new Error("Operation aborted")
              }

              // Verify jobs belong to current session
              const sessionJobs = await Job.list({ parentSessionID: ctx.sessionID })
              const sessionJobIDs = new Set(sessionJobs.map((j) => j.id))
              const sessionJobTypes = new Map(sessionJobs.map((j) => [j.id, j.type]))

              for (const jobID of params.job_ids) {
                if (!sessionJobIDs.has(jobID)) {
                  throw new Error(`Cannot access job ${jobID} from different session`)
                }
                const jobType = sessionJobTypes.get(jobID)
                if (jobType && jobType !== name) {
                  throw new Error(`Job ${jobID} is not a ${name} job`)
                }
              }

              const result = await Job.read({
                jobIDs: params.job_ids,
                limit: params.limit,
              })

              const totalFrames = result.jobs.reduce((sum, j) => sum + (j.frames?.length ?? 0), 0)
              ctx.metadata({
                title: `${totalFrames} frame(s)`,
                metadata: { totalFrames, jobCount: result.jobs.length },
              })

              const lines: string[] = []
              for (const job of result.jobs) {
                if (!job.found) {
                  lines.push(`[${job.id}] ERROR: ${job.error}`)
                  continue
                }
                lines.push(`[${job.id}] (${job.status}) - ${job.frames?.length ?? 0} frame(s)`)
                if (job.frames && job.frames.length > 0) {
                  for (const frame of job.frames) {
                    const time = new Date(frame.time.created).toISOString()
                    lines.push(`  [${time}]`)
                    lines.push(`  ${typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data)}`)
                  }
                }
                lines.push("")
              }

              return {
                title: `${totalFrames} frame(s)`,
                metadata: { jobs: result.jobs },
                output: lines.join("\n"),
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
}
