import { beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import z from "zod"
import { Bus } from "../../src/bus"
import { JobContext } from "../../src/job/context"
import { JobNotification } from "../../src/job/notification"
import type { JobRegistry } from "../../src/job/registry"
import type { JobStream } from "../../src/job/stream"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"

const projectRoot = path.join(__dirname, "../..")

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

async function cleanup(jobID: string) {
  const keys = await Storage.list(["job_stream", jobID])
  await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
}

function createMockFrame(jobID: string, data: unknown): JobStream.Frame {
  return {
    id: "job_frame_test",
    jobID,
    direction: "out",
    data,
    notify: true,
    time: {
      created: Date.now(),
    },
  }
}

describe("JobNotification", () => {
  beforeEach(async () => {
    await withInstance(async () => {
      // Clear any notifications from previous tests by draining all sessions
      JobNotification.drain("session_test1")
      JobNotification.drain("session_test2")
      JobNotification.drain("session_isolated1")
      JobNotification.drain("session_isolated2")
      JobNotification.drain("nonexistent_session")
    })
  })

  describe("hasPending", () => {
    test("returns false when no notifications", async () => {
      await withInstance(async () => {
        const result = JobNotification.hasPending("nonexistent_session")
        expect(result).toBe(false)
      })
    })
  })

  describe("drain", () => {
    test("returns empty array when no notifications", async () => {
      await withInstance(async () => {
        const result = JobNotification.drain("nonexistent_session")
        expect(result).toEqual([])
      })
    })
  })

  describe("format", () => {
    test("returns empty string for empty array", async () => {
      await withInstance(async () => {
        const result = JobNotification.format([])
        expect(result).toBe("")
      })
    })

    test("produces correct output for single notification", async () => {
      await withInstance(async () => {
        const frame = createMockFrame("job_test123", { type: "question", text: "Should I continue?" })
        const notifications = [
          {
            jobID: "job_test123",
            jobType: "subagent",
            jobTitle: "Fix bug",
            frame,
          },
        ]

        const result = JobNotification.format(notifications)

        expect(result).toContain("[Job Notification]")
        expect(result).toContain("Type: subagent")
        expect(result).toContain("Title: Fix bug")
        expect(result).toContain("ID: job_test123")
        expect(result).toContain('"type": "question"')
        expect(result).toContain('"text": "Should I continue?"')
      })
    })

    test("produces correct output for multiple notifications", async () => {
      await withInstance(async () => {
        const frame1 = createMockFrame("job_abc123", { type: "question", text: "First question?" })
        const frame2 = createMockFrame("job_def456", { type: "error", text: "Something went wrong" })
        const notifications = [
          {
            jobID: "job_abc123",
            jobType: "subagent",
            jobTitle: "Fix bug",
            frame: frame1,
          },
          {
            jobID: "job_def456",
            jobType: "monitor",
            jobTitle: "Watch files",
            frame: frame2,
          },
        ]

        const result = JobNotification.format(notifications)

        // Check separator between notifications
        expect(result).toContain("---")

        // Check first notification
        expect(result).toContain("Type: subagent")
        expect(result).toContain("Title: Fix bug")
        expect(result).toContain("ID: job_abc123")
        expect(result).toContain('"text": "First question?"')

        // Check second notification
        expect(result).toContain("Type: monitor")
        expect(result).toContain("Title: Watch files")
        expect(result).toContain("ID: job_def456")
        expect(result).toContain('"text": "Something went wrong"')
      })
    })
  })

  describe("integration with Bus events", () => {
    const paramsSchema = z.object({ value: z.string() })
    const inputSchema = z.object({ text: z.string() })
    const outputSchema = z.object({ result: z.string() })

    function createDefinition(): JobRegistry.Definition<typeof paramsSchema, typeof inputSchema, typeof outputSchema> {
      return {
        name: "test_notification_job",
        description: "Test job for notifications",
        params: paramsSchema,
        input: inputSchema,
        output: outputSchema,
        async start() {},
      }
    }

    test("Bus.subscribe receives Notify events from JobContext", async () => {
      await withInstance(async () => {
        const jobID = "job_notify_event_test"
        const sessionID = "session_notify_event_test"

        // Subscribe to events directly
        const received: Array<{ jobID: string; sessionID: string }> = []
        const unsub = Bus.subscribe(JobContext.Event.Notify, (event) => {
          received.push({
            jobID: event.properties.jobID,
            sessionID: event.properties.sessionID,
          })
        })

        // Create notification via JobContext
        const definition = createDefinition()
        const context = JobContext.create({
          jobID,
          sessionID,
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await context.context.notify({ result: "test message" })

        // Verify event was received
        expect(received.length).toBe(1)
        expect(received[0].jobID).toBe(jobID)
        expect(received[0].sessionID).toBe(sessionID)

        unsub()
        await cleanup(jobID)
      })
    })

    test("init is idempotent", async () => {
      await withInstance(async () => {
        // Calling init multiple times should not cause issues
        JobNotification.init()
        JobNotification.init()
        JobNotification.init()

        // Should still work normally after multiple inits
        const result = JobNotification.hasPending("some_session")
        expect(result).toBe(false)
      })
    })
  })
})
