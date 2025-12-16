import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Job } from "@/job"
import { JobInfo, JobStatus } from "@/job/schema"
import { JobStream } from "@/job/stream"

const Bool = z.preprocess((v) => {
  if (v === "true") return true
  if (v === "false") return false
  return v
}, z.boolean())

export const JobRoute = new Hono()
  .get(
    "/list",
    describeRoute({
      summary: "List jobs",
      description: "List jobs for the current project, optionally filtered by session/type/status.",
      operationId: "job.list",
      responses: {
        200: {
          description: "Jobs",
          content: {
            "application/json": {
              schema: resolver(JobInfo.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        parentSessionID: z.string().optional(),
        type: z.string().optional(),
        status: JobStatus.optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid("query")
      const jobs = await Job.list(input)
      return c.json(jobs)
    },
  )
  .get(
    "/frames",
    describeRoute({
      summary: "List job stream frames",
      description: "List frames from the job stream with simple filtering.",
      operationId: "job.frames",
      responses: {
        200: {
          description: "Frames",
          content: {
            "application/json": {
              schema: resolver(JobStream.Frame.array()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        jobID: z.string(),
        after: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
        direction: z.enum(["in", "out"]).optional(),
        notify: Bool.optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid("query")
      const frames = await JobStream.list({
        jobID: input.jobID,
        after: input.after,
        limit: input.limit,
      })

      const result = frames.filter((f) => {
        if (input.direction && f.direction !== input.direction) return false
        if (input.notify !== undefined && f.notify !== input.notify) return false
        return true
      })

      return c.json(result)
    },
  )
  .get(
    "/frame/latest",
    describeRoute({
      summary: "Get latest job stream frame",
      description: "Get the latest frame from the job stream matching optional filters.",
      operationId: "job.frame.latest",
      responses: {
        200: {
          description: "Latest frame (or null)",
          content: {
            "application/json": {
              schema: resolver(JobStream.Frame.nullable()),
            },
          },
        },
      },
    }),
    validator(
      "query",
      z.object({
        jobID: z.string(),
        direction: z.enum(["in", "out"]).optional(),
        notify: Bool.optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid("query")
      const frame = await JobStream.latest({
        jobID: input.jobID,
        direction: input.direction,
        notify: input.notify,
      })
      return c.json(frame ?? null)
    },
  )
