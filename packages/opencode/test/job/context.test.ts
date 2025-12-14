import { describe, expect, test } from "bun:test"
import path from "node:path"
import z from "zod"
import { Bus } from "../../src/bus"
import { JobContext } from "../../src/job/context"
import type { JobRegistry } from "../../src/job/registry"
import { JobStream } from "../../src/job/stream"
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

describe("JobContext.create", () => {
  const paramsSchema = z.object({ value: z.string() })
  const inputSchema = z.object({ text: z.string() })
  const outputSchema = z.object({ result: z.string() })

  function createDefinition(options?: {
    hasInput?: boolean
    hasOutput?: boolean
  }): JobRegistry.Definition<typeof paramsSchema, typeof inputSchema, typeof outputSchema> {
    return {
      name: "test_job",
      description: "Test job",
      params: paramsSchema,
      input: options?.hasInput !== false ? inputSchema : undefined,
      output: options?.hasOutput !== false ? outputSchema : undefined,
      async start() {},
    }
  }

  describe("onInput", () => {
    test("throws if input schema not defined", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasInput: false })
        const result = JobContext.create({
          jobID: "job_test1",
          sessionID: "session_test1",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        expect(() => result.context.onInput(() => {})).toThrow(JobContext.InputNotDefinedError)
      })
    })

    test("throws on second call (one-time binding)", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasInput: true })
        const result = JobContext.create({
          jobID: "job_test2",
          sessionID: "session_test2",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        result.context.onInput(() => {})
        expect(() => result.context.onInput(() => {})).toThrow(JobContext.InputAlreadyBoundError)
      })
    })

    test("returns unsubscribe function", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasInput: true })
        const result = JobContext.create({
          jobID: "job_test3",
          sessionID: "session_test3",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        const unsubscribe = result.context.onInput(() => {})
        expect(typeof unsubscribe).toBe("function")

        // After unsubscribe, can bind again
        unsubscribe()
        expect(() => result.context.onInput(() => {})).not.toThrow()
      })
    })

    test("delivers input to callback", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasInput: true })
        const result = JobContext.create({
          jobID: "job_test4",
          sessionID: "session_test4",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        const received: Array<{ text: string }> = []
        result.context.onInput((data) => received.push(data))

        result.deliverInput({ text: "hello" })
        result.deliverInput({ text: "world" })

        expect(received).toEqual([{ text: "hello" }, { text: "world" }])
      })
    })
  })

  describe("onSignal", () => {
    test("throws on second call (one-time binding)", async () => {
      await withInstance(async () => {
        const definition = createDefinition()
        const result = JobContext.create({
          jobID: "job_test5",
          sessionID: "session_test5",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        result.context.onSignal(() => {})
        expect(() => result.context.onSignal(() => {})).toThrow(JobContext.SignalAlreadyBoundError)
      })
    })

    test("returns unsubscribe function", async () => {
      await withInstance(async () => {
        const definition = createDefinition()
        const result = JobContext.create({
          jobID: "job_test6",
          sessionID: "session_test6",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        const unsubscribe = result.context.onSignal(() => {})
        expect(typeof unsubscribe).toBe("function")

        // After unsubscribe, can bind again
        unsubscribe()
        expect(() => result.context.onSignal(() => {})).not.toThrow()
      })
    })

    test("delivers abort signal to callback", async () => {
      await withInstance(async () => {
        const definition = createDefinition()
        const result = JobContext.create({
          jobID: "job_test7",
          sessionID: "session_test7",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        const signals: string[] = []
        result.context.onSignal((signal) => signals.push(signal))

        result.deliverSignal("abort")

        expect(signals).toEqual(["abort"])
      })
    })
  })

  describe("emit", () => {
    test("throws if output schema not defined", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasOutput: false })
        const result = JobContext.create({
          jobID: "job_test8",
          sessionID: "session_test8",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await expect(result.context.emit({ result: "test" })).rejects.toThrow(JobContext.OutputNotDefinedError)
      })
    })

    test("throws if output validation fails", async () => {
      await withInstance(async () => {
        const jobID = "job_test9"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test9",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        // @ts-expect-error - testing invalid input
        await expect(result.context.emit({ invalid: "field" })).rejects.toThrow(JobContext.OutputValidationError)
        await cleanup(jobID)
      })
    })

    test("stores frame with notify: false", async () => {
      await withInstance(async () => {
        const jobID = "job_test10"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test10",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.emit({ result: "hello" })

        const frames = await JobStream.list({ jobID })
        expect(frames.length).toBe(1)
        expect(frames[0].notify).toBe(false)
        expect(frames[0].direction).toBe("out")
        expect(frames[0].data).toEqual({ result: "hello" })

        await cleanup(jobID)
      })
    })

    test("no-op with warning after terminal state", async () => {
      await withInstance(async () => {
        const jobID = "job_test11"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test11",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.complete()
        await result.context.emit({ result: "after-complete" })

        const frames = await JobStream.list({ jobID })
        expect(frames.length).toBe(0)

        await cleanup(jobID)
      })
    })
  })

  describe("notify", () => {
    test("throws if output schema not defined", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasOutput: false })
        const result = JobContext.create({
          jobID: "job_test12",
          sessionID: "session_test12",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await expect(result.context.notify({ result: "test" })).rejects.toThrow(JobContext.OutputNotDefinedError)
      })
    })

    test("stores frame with notify: true", async () => {
      await withInstance(async () => {
        const jobID = "job_test13"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test13",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.notify({ result: "notification" })

        const frames = await JobStream.list({ jobID })
        expect(frames.length).toBe(1)
        expect(frames[0].notify).toBe(true)
        expect(frames[0].direction).toBe("out")
        expect(frames[0].data).toEqual({ result: "notification" })

        await cleanup(jobID)
      })
    })

    test("fires Job.Event.Notify event", async () => {
      await withInstance(async () => {
        const jobID = "job_test14"
        const sessionID = "session_test14"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID,
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        const events: Array<{ jobID: string; sessionID: string }> = []
        const unsub = Bus.subscribe(JobContext.Event.Notify, (event) => {
          events.push({ jobID: event.properties.jobID, sessionID: event.properties.sessionID })
        })

        await result.context.notify({ result: "test" })

        expect(events.length).toBe(1)
        expect(events[0].jobID).toBe(jobID)
        expect(events[0].sessionID).toBe(sessionID)

        unsub()
        await cleanup(jobID)
      })
    })

    test("no-op after terminal state", async () => {
      await withInstance(async () => {
        const jobID = "job_test15"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test15",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.fail("error")
        await result.context.notify({ result: "after-fail" })

        const frames = await JobStream.list({ jobID })
        expect(frames.length).toBe(0)

        await cleanup(jobID)
      })
    })
  })

  describe("complete", () => {
    test("complete() always allowed without output", async () => {
      await withInstance(async () => {
        const jobID = "job_test16"
        const statuses: string[] = []
        const definition = createDefinition({ hasOutput: false })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test16",
          params: { value: "test" },
          definition,
          onStatusChange: (status) => statuses.push(status),
        })

        await result.context.complete()

        expect(statuses).toEqual(["completed"])
        await cleanup(jobID)
      })
    })

    test("complete(output) throws if no output schema", async () => {
      await withInstance(async () => {
        const definition = createDefinition({ hasOutput: false })
        const result = JobContext.create({
          jobID: "job_test17",
          sessionID: "session_test17",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await expect(result.context.complete({ result: "final" })).rejects.toThrow(JobContext.OutputNotDefinedError)
      })
    })

    test("complete(output) stores frame", async () => {
      await withInstance(async () => {
        const jobID = "job_test18"
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test18",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.complete({ result: "final" })

        const frames = await JobStream.list({ jobID })
        expect(frames.length).toBe(1)
        expect(frames[0].data).toEqual({ result: "final" })

        await cleanup(jobID)
      })
    })

    test("no-op after terminal state", async () => {
      await withInstance(async () => {
        const jobID = "job_test19"
        const statuses: string[] = []
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test19",
          params: { value: "test" },
          definition,
          onStatusChange: (status) => statuses.push(status),
        })

        await result.context.complete()
        await result.context.complete({ result: "second" })

        expect(statuses).toEqual(["completed"])
        await cleanup(jobID)
      })
    })

    test("sets job status to completed", async () => {
      await withInstance(async () => {
        const jobID = "job_test20"
        const statuses: string[] = []
        const definition = createDefinition({ hasOutput: true })
        const result = JobContext.create({
          jobID,
          sessionID: "session_test20",
          params: { value: "test" },
          definition,
          onStatusChange: (status) => statuses.push(status),
        })

        await result.context.complete({ result: "done" })

        expect(statuses).toEqual(["completed"])
        await cleanup(jobID)
      })
    })
  })

  describe("fail", () => {
    test("sets job status to error", async () => {
      await withInstance(async () => {
        const jobID = "job_test21"
        const statuses: string[] = []
        const definition = createDefinition()
        const result = JobContext.create({
          jobID,
          sessionID: "session_test21",
          params: { value: "test" },
          definition,
          onStatusChange: (status) => statuses.push(status),
        })

        await result.context.fail("something went wrong")

        expect(statuses).toEqual(["error"])
        await cleanup(jobID)
      })
    })

    test("no-op after terminal state", async () => {
      await withInstance(async () => {
        const jobID = "job_test22"
        const statuses: string[] = []
        const definition = createDefinition()
        const result = JobContext.create({
          jobID,
          sessionID: "session_test22",
          params: { value: "test" },
          definition,
          onStatusChange: (status) => statuses.push(status),
        })

        await result.context.fail("first error")
        await result.context.fail("second error")

        expect(statuses).toEqual(["error"])
        await cleanup(jobID)
      })
    })
  })

  describe("setMetadata", () => {
    test("shallow merges metadata", async () => {
      await withInstance(async () => {
        const definition = createDefinition()
        const result = JobContext.create({
          jobID: "job_test23",
          sessionID: "session_test23",
          params: { value: "test" },
          definition,
          onStatusChange: () => {},
        })

        await result.context.setMetadata({ key1: "value1" })
        await result.context.setMetadata({ key2: "value2" })
        // Note: metadata is internal, so we just verify it doesn't throw
      })
    })
  })

  describe("context properties", () => {
    test("exposes jobID, sessionID, and params", async () => {
      await withInstance(async () => {
        const jobID = "job_test24"
        const sessionID = "session_test24"
        const params = { value: "test-value" }
        const definition = createDefinition()
        const result = JobContext.create({
          jobID,
          sessionID,
          params,
          definition,
          onStatusChange: () => {},
        })

        expect(result.context.jobID).toBe(jobID)
        expect(result.context.sessionID).toBe(sessionID)
        expect(result.context.params).toEqual(params)
      })
    })
  })
})
