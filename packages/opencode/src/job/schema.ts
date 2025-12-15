import z from "zod"
import { Identifier } from "@/id/id"

/**
 * Job schemas - separated to avoid circular dependencies.
 * These schemas can be imported by server/job.ts without triggering
 * the full Job module dependency chain.
 */

export const JobStatus = z.enum(["pending", "running", "completed", "error", "canceled"]).meta({
  ref: "JobStatus",
})

export type JobStatus = z.infer<typeof JobStatus>

export const JobInfo = z
  .object({
    id: Identifier.schema("job"),
    projectID: z.string(),
    type: z.string(),
    title: z.string(),
    parentSessionID: Identifier.schema("session"),
    status: JobStatus,
    params: z.unknown(),
    metadata: z.record(z.string(), z.any()).optional(),
    error: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      started: z.number().optional(),
      completed: z.number().optional(),
    }),
  })
  .meta({
    ref: "Job",
  })

export type JobInfo = z.infer<typeof JobInfo>
