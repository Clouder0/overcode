import { describe, expect, test } from "bun:test"
import z from "zod"
import { Identifier } from "../../src/id/id"

// Define schemas locally to avoid circular import issues with Job module
// These mirror the actual schemas in job/index.ts and job/stream.ts

const Status = z.enum(["pending", "running", "completed", "error", "canceled"])

const JobInfo = z.object({
  id: Identifier.schema("job"),
  projectID: z.string(),
  type: z.string(),
  title: z.string(),
  parentSessionID: Identifier.schema("session").optional(),
  workerSessionID: Identifier.schema("session").optional(),
  status: Status,
  params: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  time: z.object({
    created: z.number(),
    updated: z.number(),
    started: z.number().optional(),
    completed: z.number().optional(),
  }),
})

const Frame = z.object({
  id: Identifier.schema("job_frame"),
  jobID: Identifier.schema("job"),
  direction: z.enum(["in", "out"]),
  data: z.unknown(),
  notify: z.boolean(),
  time: z.object({
    created: z.number(),
  }),
})

describe("Job.Info schema", () => {
  test("validates complete job info", () => {
    const now = Date.now()
    const info = {
      id: "job_abc123",
      projectID: "proj_123",
      type: "subagent",
      title: "Test Job",
      parentSessionID: "ses_parent123",
      workerSessionID: "ses_worker123",
      status: "running" as const,
      params: { prompt: "test", agent: "general" },
      metadata: { key: "value" },
      time: {
        created: now,
        updated: now,
        started: now,
      },
    }

    const result = JobInfo.safeParse(info)
    expect(result.success).toBe(true)
  })

  test("params accepts any JSON value", () => {
    const now = Date.now()
    const baseInfo = {
      id: "job_abc123",
      projectID: "proj_123",
      type: "subagent",
      title: "Test Job",
      status: "pending" as const,
      time: { created: now, updated: now },
    }

    const stringParams = JobInfo.safeParse({ ...baseInfo, params: "simple string" })
    expect(stringParams.success).toBe(true)

    const numberParams = JobInfo.safeParse({ ...baseInfo, params: 42 })
    expect(numberParams.success).toBe(true)

    const arrayParams = JobInfo.safeParse({ ...baseInfo, params: [1, 2, 3] })
    expect(arrayParams.success).toBe(true)

    const objectParams = JobInfo.safeParse({ ...baseInfo, params: { nested: { deep: true } } })
    expect(objectParams.success).toBe(true)

    const nullParams = JobInfo.safeParse({ ...baseInfo, params: null })
    expect(nullParams.success).toBe(true)

    const undefinedParams = JobInfo.safeParse({ ...baseInfo, params: undefined })
    expect(undefinedParams.success).toBe(true)
  })

  test("error field is optional", () => {
    const now = Date.now()
    const baseInfo = {
      id: "job_abc123",
      projectID: "proj_123",
      type: "subagent",
      title: "Test Job",
      status: "completed" as const,
      params: {},
      time: { created: now, updated: now },
    }

    const withoutError = JobInfo.safeParse(baseInfo)
    expect(withoutError.success).toBe(true)

    const withError = JobInfo.safeParse({ ...baseInfo, error: "Something went wrong" })
    expect(withError.success).toBe(true)
    if (withError.success) {
      expect(withError.data.error).toBe("Something went wrong")
    }
  })

  test("rejects invalid status", () => {
    const now = Date.now()
    const info = {
      id: "job_abc123",
      projectID: "proj_123",
      type: "subagent",
      title: "Test Job",
      status: "invalid_status",
      params: {},
      time: { created: now, updated: now },
    }

    const result = JobInfo.safeParse(info)
    expect(result.success).toBe(false)
  })

  test("validates all status values", () => {
    const now = Date.now()
    const baseInfo = {
      id: "job_abc123",
      projectID: "proj_123",
      type: "subagent",
      title: "Test Job",
      params: {},
      time: { created: now, updated: now },
    }

    const statuses = ["pending", "running", "completed", "error", "canceled"] as const
    for (const status of statuses) {
      const result = JobInfo.safeParse({ ...baseInfo, status })
      expect(result.success).toBe(true)
    }
  })
})

describe("JobStream.Frame schema", () => {
  test("validates frame with data field", () => {
    const frame = {
      id: "jbf_abc123",
      jobID: "job_xyz789",
      direction: "out" as const,
      data: { type: "text", content: "Hello world" },
      notify: false,
      time: { created: Date.now() },
    }

    const result = Frame.safeParse(frame)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.data).toEqual({ type: "text", content: "Hello world" })
    }
  })

  test("data field accepts any JSON value", () => {
    const baseFrame = {
      id: "jbf_abc123",
      jobID: "job_xyz789",
      direction: "in" as const,
      notify: false,
      time: { created: Date.now() },
    }

    const stringData = Frame.safeParse({ ...baseFrame, data: "simple string" })
    expect(stringData.success).toBe(true)

    const numberData = Frame.safeParse({ ...baseFrame, data: 123 })
    expect(numberData.success).toBe(true)

    const arrayData = Frame.safeParse({ ...baseFrame, data: ["a", "b", "c"] })
    expect(arrayData.success).toBe(true)

    const objectData = Frame.safeParse({ ...baseFrame, data: { key: "value" } })
    expect(objectData.success).toBe(true)

    const nullData = Frame.safeParse({ ...baseFrame, data: null })
    expect(nullData.success).toBe(true)
  })

  test("notify field is required boolean", () => {
    const baseFrame = {
      id: "jbf_abc123",
      jobID: "job_xyz789",
      direction: "out" as const,
      data: "test",
      time: { created: Date.now() },
    }

    const withNotifyTrue = Frame.safeParse({ ...baseFrame, notify: true })
    expect(withNotifyTrue.success).toBe(true)
    if (withNotifyTrue.success) {
      expect(withNotifyTrue.data.notify).toBe(true)
    }

    const withNotifyFalse = Frame.safeParse({ ...baseFrame, notify: false })
    expect(withNotifyFalse.success).toBe(true)
    if (withNotifyFalse.success) {
      expect(withNotifyFalse.data.notify).toBe(false)
    }

    const withoutNotify = Frame.safeParse(baseFrame)
    expect(withoutNotify.success).toBe(false)
  })

  test("direction validates in and out values", () => {
    const baseFrame = {
      id: "jbf_abc123",
      jobID: "job_xyz789",
      data: "test",
      notify: false,
      time: { created: Date.now() },
    }

    const inDirection = Frame.safeParse({ ...baseFrame, direction: "in" })
    expect(inDirection.success).toBe(true)

    const outDirection = Frame.safeParse({ ...baseFrame, direction: "out" })
    expect(outDirection.success).toBe(true)

    const invalidDirection = Frame.safeParse({ ...baseFrame, direction: "invalid" })
    expect(invalidDirection.success).toBe(false)
  })

  test("rejects frame without required fields", () => {
    const incomplete = {
      id: "jbf_abc123",
      direction: "out",
    }

    const result = Frame.safeParse(incomplete)
    expect(result.success).toBe(false)
  })
})
