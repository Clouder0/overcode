import { describe, expect, test } from "bun:test"
import type z from "zod"
import type { JobRegistry } from "../../src/job/registry"
import { JobBridge } from "../../src/tool/job-bridge"

function createMockContext() {
  const emitted: unknown[] = []
  const notified: unknown[] = []
  const state = {
    completed: false,
    failed: false,
    error: "",
  }

  const context: JobRegistry.JobContext<z.ZodType, z.ZodType, z.ZodType> = {
    jobID: "job_test",
    sessionID: "ses_test",
    params: {},
    onInput: () => () => {},
    onSignal: () => () => {},
    emit: async (output: unknown) => {
      emitted.push(output)
    },
    notify: async (output: unknown) => {
      notified.push(output)
    },
    complete: async () => {
      state.completed = true
    },
    fail: async (error: string) => {
      state.failed = true
      state.error = error
    },
    setMetadata: async () => {},
  }

  return {
    context,
    getEmitted: () => emitted,
    getNotified: () => notified,
    getState: () => state,
  }
}

function createToolContext() {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "test",
    abort: new AbortController().signal,
    callID: "call_test",
    metadata: () => {},
  }
}

describe("JobBridge", () => {
  describe("createTools", () => {
    test("returns all four bridge tools", () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)

      expect(tools.job_emit).toBeDefined()
      expect(tools.job_notify).toBeDefined()
      expect(tools.job_complete).toBeDefined()
      expect(tools.job_fail).toBeDefined()
    })

    test("tools have correct ids", () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)

      expect(tools.job_emit.id).toBe("job_emit")
      expect(tools.job_notify.id).toBe("job_notify")
      expect(tools.job_complete.id).toBe("job_complete")
      expect(tools.job_fail.id).toBe("job_fail")
    })
  })

  describe("job_emit", () => {
    test("calls context.emit with output", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_emit.init()
      const ctx = createToolContext()

      await tool.execute({ output: { type: "progress", text: "Working..." } }, ctx)

      expect(mock.getEmitted()).toEqual([{ type: "progress", text: "Working..." }])
    })

    test("returns success confirmation", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_emit.init()
      const ctx = createToolContext()

      const result = await tool.execute({ output: "test output" }, ctx)

      expect(result.title).toBe("Output emitted")
      expect(result.output).toBe("Output sent successfully")
    })

    test("handles multiple emits", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_emit.init()
      const ctx = createToolContext()

      await tool.execute({ output: "first" }, ctx)
      await tool.execute({ output: "second" }, ctx)
      await tool.execute({ output: "third" }, ctx)

      expect(mock.getEmitted()).toEqual(["first", "second", "third"])
    })

    test("has correct description", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_emit.init()

      expect(tool.description).toContain("pollable")
    })
  })

  describe("job_notify", () => {
    test("calls context.notify with output", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_notify.init()
      const ctx = createToolContext()

      await tool.execute({ output: { type: "question", text: "Should I continue?" } }, ctx)

      expect(mock.getNotified()).toEqual([{ type: "question", text: "Should I continue?" }])
    })

    test("returns success confirmation", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_notify.init()
      const ctx = createToolContext()

      const result = await tool.execute({ output: "notification" }, ctx)

      expect(result.title).toBe("Notification sent")
      expect(result.output).toBe("Notification sent successfully")
    })

    test("has correct description", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_notify.init()

      expect(tool.description).toContain("push")
      expect(tool.description).toContain("immediate")
    })
  })

  describe("job_complete", () => {
    test("calls context.complete without output", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_complete.init()
      const ctx = createToolContext()

      await tool.execute({}, ctx)

      expect(mock.getState().completed).toBe(true)
    })

    test("calls context.complete with output", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_complete.init()
      const ctx = createToolContext()

      await tool.execute({ output: { type: "result", text: "Done!" } }, ctx)

      expect(mock.getState().completed).toBe(true)
    })

    test("returns success confirmation", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_complete.init()
      const ctx = createToolContext()

      const result = await tool.execute({ output: "final result" }, ctx)

      expect(result.title).toBe("Job completed")
      expect(result.output).toBe("Job marked as complete")
    })

    test("has correct description", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_complete.init()

      expect(tool.description).toContain("complete")
    })
  })

  describe("job_fail", () => {
    test("calls context.fail with error", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_fail.init()
      const ctx = createToolContext()

      await tool.execute({ error: "Something went wrong" }, ctx)

      expect(mock.getState().failed).toBe(true)
      expect(mock.getState().error).toBe("Something went wrong")
    })

    test("returns failure confirmation with error message", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_fail.init()
      const ctx = createToolContext()

      const result = await tool.execute({ error: "Network timeout" }, ctx)

      expect(result.title).toBe("Job failed")
      expect(result.output).toBe("Job marked as failed: Network timeout")
    })

    test("has correct description", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_fail.init()

      expect(tool.description).toContain("failed")
      expect(tool.description).toContain("error")
    })
  })

  describe("parameter validation", () => {
    test("job_emit validates output parameter", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_emit.init()
      const ctx = createToolContext()

      // z.unknown() accepts anything, so this should work
      await tool.execute({ output: null }, ctx)
      await tool.execute({ output: undefined }, ctx)
      await tool.execute({ output: 123 }, ctx)
      await tool.execute({ output: "string" }, ctx)
      await tool.execute({ output: { nested: { value: true } } }, ctx)

      expect(mock.getEmitted().length).toBe(5)
    })

    test("job_fail requires error string", async () => {
      const mock = createMockContext()
      const tools = JobBridge.createTools(mock.context)
      const tool = await tools.job_fail.init()
      const ctx = createToolContext()

      // Empty string is valid
      await tool.execute({ error: "" }, ctx)
      expect(mock.getState().failed).toBe(true)
    })
  })

  describe("tools are bound to specific context", () => {
    test("different contexts have independent state", async () => {
      const mock1 = createMockContext()
      const mock2 = createMockContext()

      const tools1 = JobBridge.createTools(mock1.context)
      const tools2 = JobBridge.createTools(mock2.context)

      const emit1 = await tools1.job_emit.init()
      const emit2 = await tools2.job_emit.init()
      const ctx = createToolContext()

      await emit1.execute({ output: "context1-data" }, ctx)
      await emit2.execute({ output: "context2-data" }, ctx)

      expect(mock1.getEmitted()).toEqual(["context1-data"])
      expect(mock2.getEmitted()).toEqual(["context2-data"])
    })

    test("complete on one context does not affect another", async () => {
      const mock1 = createMockContext()
      const mock2 = createMockContext()

      const tools1 = JobBridge.createTools(mock1.context)
      // Create tools for mock2 to ensure contexts are independent
      JobBridge.createTools(mock2.context)

      const complete1 = await tools1.job_complete.init()
      const ctx = createToolContext()

      await complete1.execute({}, ctx)

      expect(mock1.getState().completed).toBe(true)
      expect(mock2.getState().completed).toBe(false)
    })
  })
})
