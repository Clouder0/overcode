import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Hono } from "hono"
import { JobRoute } from "../../src/server/job"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { JobStream } from "../../src/job/stream"

const projectRoot = path.join(__dirname, "../..")

const app = new Hono().use(async (_c, next) => {
  return Instance.provide({
    directory: projectRoot,
    fn: () => next(),
  })
})

app.route("/job", JobRoute)

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

async function createJob(input: {
  sessionID: string
  type: string
  title: string
  status: "pending" | "running" | "completed" | "error" | "canceled"
  created?: number
}) {
  return withInstance(async () => {
    const now = input.created ?? Date.now()
    const jobID = Identifier.descending("job")
    const projectID = Instance.project.id

    await Storage.write(["job", projectID, jobID], {
      id: jobID,
      projectID,
      type: input.type,
      title: input.title,
      parentSessionID: input.sessionID,
      status: input.status,
      params: {},
      time: {
        created: now,
        updated: now,
        started: input.status === "running" ? now : undefined,
        completed: ["completed", "error", "canceled"].includes(input.status) ? now : undefined,
      },
    })

    return jobID
  })
}

describe("Job API routes", () => {
  test("GET /job/list filters by parentSessionID", async () => {
    const sessionID = await withInstance(async () => (await Session.create({})).id)

    const job1 = await createJob({ sessionID, type: "subagent", title: "A", status: "running" })
    const job2 = await createJob({ sessionID, type: "subagent", title: "B", status: "completed" })

    const res = await app.request(`/job/list?parentSessionID=${sessionID}`)

    expect(res.status).toBe(200)
    const jobs = (await res.json()) as Array<{ id: string; parentSessionID: string }>

    expect(jobs.some((j) => j.id === job1)).toBe(true)
    expect(jobs.some((j) => j.id === job2)).toBe(true)
    expect(jobs.every((j) => j.parentSessionID === sessionID)).toBe(true)
  })

  test("GET /job/frames supports notify/direction filtering", async () => {
    const sessionID = await withInstance(async () => (await Session.create({})).id)
    const jobID = await createJob({ sessionID, type: "subagent", title: "Frames", status: "running" })

    await withInstance(async () => {
      await JobStream.append({ jobID, sessionID, direction: "out", data: "progress", notify: false })
      await JobStream.append({
        jobID,
        sessionID,
        direction: "out",
        data: { type: "question", text: "ping" },
        notify: true,
      })
      await JobStream.append({ jobID, sessionID, direction: "in", data: "reply", notify: false })
    })

    const notifyRes = await app.request(`/job/frames?jobID=${jobID}&direction=out&notify=true`)
    expect(notifyRes.status).toBe(200)
    const notifyFrames = (await notifyRes.json()) as Array<{ direction: string; notify: boolean }>
    expect(notifyFrames.length).toBe(1)
    expect(notifyFrames[0]?.direction).toBe("out")
    expect(notifyFrames[0]?.notify).toBe(true)

    const inRes = await app.request(`/job/frames?jobID=${jobID}&direction=in`)
    expect(inRes.status).toBe(200)
    const inFrames = (await inRes.json()) as Array<{ direction: string }>
    expect(inFrames.length).toBeGreaterThan(0)
    expect(inFrames.every((f) => f.direction === "in")).toBe(true)
  })

  test("GET /job/frame/latest returns latest matching frame", async () => {
    const sessionID = await withInstance(async () => (await Session.create({})).id)
    const jobID = await createJob({ sessionID, type: "subagent", title: "Latest", status: "running" })

    await withInstance(async () => {
      await JobStream.append({ jobID, sessionID, direction: "out", data: "first", notify: false })
      await JobStream.append({ jobID, sessionID, direction: "out", data: "second", notify: false })
    })

    const res = await app.request(`/job/frame/latest?jobID=${jobID}&direction=out&notify=false`)

    expect(res.status).toBe(200)
    const frame = (await res.json()) as { data?: unknown } | null
    expect(frame?.data).toBe("second")
  })
})
