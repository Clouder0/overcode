import { describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../../src/project/instance"

// Mock SessionPrompt for deterministic behavior
mock.module("@/session/prompt", () => ({
  SessionPrompt: {
    async resolvePromptParts(template: string) {
      return [{ type: "text", text: template }]
    },
    cancel(_sessionID: string) {},
    async prompt() {
      return {
        info: {
          id: "msg_test",
          role: "assistant",
          sessionID: "session_test",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [],
      }
    },
  },
}))

// Mock Agent for tests
mock.module("@/agent/agent", () => ({
  Agent: {
    async get(name: string) {
      if (name === "unknown") return undefined
      if (name === "build") {
        return {
          name: "build",
          mode: "primary",
          builtIn: true,
        }
      }
      return {
        name,
        mode: "subagent",
        builtIn: true,
      }
    },
    async list() {
      return [
        { name: "general", mode: "subagent", builtIn: true },
        { name: "explore", mode: "subagent", builtIn: true },
        { name: "build", mode: "primary", builtIn: true },
      ]
    },
  },
}))

// Mock Session for tests
mock.module("@/session", () => ({
  Session: {
    async create() {
      return { id: `session_${Date.now()}` }
    },
  },
}))

const projectRoot = path.join(__dirname, "../../..")

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

describe("SubagentJob definition", () => {
  test("is registered with correct name", async () => {
    await withInstance(async () => {
      // Import inside Instance context so registration works
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      expect(SubagentJob.name).toBe("subagent")
    })
  })

  test("can be retrieved from registry", async () => {
    await withInstance(async () => {
      // Import job module which imports definitions
      await import("../../../src/job")
      const { JobRegistry } = await import("../../../src/job/registry")

      const definition = JobRegistry.get("subagent")
      expect(definition).toBeDefined()
      expect(definition?.name).toBe("subagent")
    })
  })

  test("has correct params schema", async () => {
    await withInstance(async () => {
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      const params = SubagentJob.params
      expect(params).toBeDefined()

      // Test valid params
      const valid = params.safeParse({
        agent: "general",
        prompt: "do something",
      })
      expect(valid.success).toBe(true)

      // Test with optional session_id
      const withSession = params.safeParse({
        agent: "general",
        prompt: "do something",
        session_id: "session_123",
      })
      expect(withSession.success).toBe(true)

      // Test invalid params (missing required fields)
      const invalid = params.safeParse({
        agent: "general",
      })
      expect(invalid.success).toBe(false)
    })
  })

  test("has input schema", async () => {
    await withInstance(async () => {
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      const input = SubagentJob.input
      expect(input).toBeDefined()

      // Test valid input
      const valid = input?.safeParse({ text: "follow-up" })
      expect(valid?.success).toBe(true)

      // Test invalid input
      const invalid = input?.safeParse({})
      expect(invalid?.success).toBe(false)
    })
  })

  test("has output schema", async () => {
    await withInstance(async () => {
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      const output = SubagentJob.output
      expect(output).toBeDefined()

      // Test valid outputs
      const progress = output?.safeParse({ type: "progress", text: "step done" })
      expect(progress?.success).toBe(true)

      const result = output?.safeParse({ type: "result", text: "completed" })
      expect(result?.success).toBe(true)

      const question = output?.safeParse({ type: "question", text: "what next?" })
      expect(question?.success).toBe(true)

      const error = output?.safeParse({ type: "error", text: "failed" })
      expect(error?.success).toBe(true)

      // Test invalid type
      const invalid = output?.safeParse({ type: "invalid", text: "test" })
      expect(invalid?.success).toBe(false)
    })
  })

  test("description is async and lists available agents", async () => {
    await withInstance(async () => {
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      const description = SubagentJob.description
      expect(typeof description).toBe("function")

      const result = await (description as () => Promise<string>)()
      expect(result).toContain("Launch one or more subagents")
      expect(result).toContain("general")
      expect(result).toContain("explore")
      // Should NOT contain primary agent
      expect(result).not.toContain("build")
    })
  })

  test("has start function", async () => {
    await withInstance(async () => {
      const { SubagentJob } = await import("../../../src/job/definitions/subagent")
      expect(typeof SubagentJob.start).toBe("function")
    })
  })
})
