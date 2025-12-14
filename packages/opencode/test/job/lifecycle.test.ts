/**
 * Job Lifecycle Tests for Phase 2B - Job.create, Job.send, Job.wait
 *
 * NOTE: These tests require mocking SessionPrompt to avoid circular import issues.
 *
 * For full integration tests of the job lifecycle, see `test/job.runtime.test.ts`
 * which includes comprehensive mocking of the SessionPrompt module.
 *
 * This file tests the schema validation and error handling aspects that can be
 * tested without the full import chain.
 */
import { describe, expect, test, mock } from "bun:test"
import path from "node:path"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"

// Mock SessionPrompt to break the circular dependency chain
mock.module("@/session/prompt", () => ({
  SessionPrompt: {
    async resolvePromptParts() {
      return []
    },
    cancel() {},
    async prompt() {
      return { info: {}, parts: [] }
    },
  },
}))

// Mock Agent to avoid additional dependencies
mock.module("@/agent/agent", () => ({
  Agent: {
    async get() {
      return null
    },
  },
}))

const projectRoot = path.join(__dirname, "../..")

// Test schemas matching the implementation
const TestParamsSchema = z.object({ value: z.string() })
const TestInputSchema = z.object({ text: z.string() })
const TestOutputSchema = z.object({ result: z.string() })

describe("Job.create schema validation", () => {
  test("CreateInput schema validates correctly", async () => {
    const { Job } = await import("../../src/job")

    const validInput = {
      definition: "test_job",
      sessionID: "session_123abc",
      title: "Test Job",
      params: { key: "value" },
    }

    const result = Job.CreateInput.safeParse(validInput)
    expect(result.success).toBe(true)
  })

  test("CreateInput schema rejects invalid sessionID", async () => {
    const { Job } = await import("../../src/job")

    const invalidInput = {
      definition: "test_job",
      sessionID: "invalid-session", // Should start with "session_"
      title: "Test Job",
      params: {},
    }

    const result = Job.CreateInput.safeParse(invalidInput)
    expect(result.success).toBe(false)
  })
})

describe("Job.send schema validation", () => {
  test("SendInput schema validates correctly", async () => {
    const { Job } = await import("../../src/job")

    const validInput = {
      jobID: "job_123abc",
      input: { text: "hello" },
    }

    const result = Job.SendInput.safeParse(validInput)
    expect(result.success).toBe(true)
  })
})

describe("Job.wait schema validation", () => {
  test("WaitInput schema validates correctly", async () => {
    const { Job } = await import("../../src/job")

    const validInput = {
      jobID: "job_123abc",
      timeout: 5000,
    }

    const result = Job.WaitInput.safeParse(validInput)
    expect(result.success).toBe(true)
  })

  test("WaitInput schema accepts optional timeout", async () => {
    const { Job } = await import("../../src/job")

    const inputWithoutTimeout = {
      jobID: "job_123abc",
    }

    const result = Job.WaitInput.safeParse(inputWithoutTimeout)
    expect(result.success).toBe(true)
  })

  test("WaitOutput schema matches expected structure", async () => {
    const { Job } = await import("../../src/job")

    const output = {
      status: "completed" as const,
      output: [],
      error: undefined,
    }

    const result = Job.WaitOutput.safeParse(output)
    expect(result.success).toBe(true)
  })
})

describe("Job error types", () => {
  test("DefinitionNotFoundError can be created", async () => {
    const { Job } = await import("../../src/job")

    const error = new Job.DefinitionNotFoundError({ type: "unknown_job" })
    expect(error.data.type).toBe("unknown_job")
  })

  test("InputNotDefinedError can be created", async () => {
    const { Job } = await import("../../src/job")

    const error = new Job.InputNotDefinedError({ jobID: "job_123" })
    expect(error.data.jobID).toBe("job_123")
  })

  test("InputValidationError can be created", async () => {
    const { Job } = await import("../../src/job")

    const issues: z.core.$ZodIssue[] = [
      {
        code: "invalid_type",
        expected: "number",
        path: ["count"],
        message: "Expected number, received string",
      } as z.core.$ZodIssue,
    ]

    const error = new Job.InputValidationError({ jobID: "job_123", issues })
    expect(error.data.jobID).toBe("job_123")
    expect(error.data.issues).toHaveLength(1)
  })

  test("ParamsValidationError can be created", async () => {
    const { Job } = await import("../../src/job")

    const issues: z.core.$ZodIssue[] = []
    const error = new Job.ParamsValidationError({ definition: "test_job", issues })
    expect(error.data.definition).toBe("test_job")
  })

  test("TerminalStateError can be created", async () => {
    const { Job } = await import("../../src/job")

    const error = new Job.TerminalStateError({ jobID: "job_123", status: "completed" })
    expect(error.data.jobID).toBe("job_123")
    expect(error.data.status).toBe("completed")
  })
})

describe("Job.create integration", () => {
  test("DefinitionNotFoundError thrown for unknown definition", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { Session } = await import("../../src/session")

        const session = await Session.create({ title: "Test Session" })

        try {
          await expect(
            Job.create({
              definition: "nonexistent_definition_xyz",
              sessionID: session.id,
              title: "Test Job",
              params: {},
            }),
          ).rejects.toThrow(Job.DefinitionNotFoundError)
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("ParamsValidationError thrown for invalid params", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_params_validation_job", {
          description: "Test job for params validation",
          params: z.object({ count: z.number() }),
          async start() {},
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          await expect(
            Job.create({
              definition: "test_params_validation_job",
              sessionID: session.id,
              title: "Test Job",
              params: { count: "not a number" },
            }),
          ).rejects.toThrow(Job.ParamsValidationError)
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("ParentSessionNotFoundError thrown for invalid session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")

        JobRegistry.define("test_session_not_found_job", {
          description: "Test job",
          params: z.object({}),
          async start() {},
        })

        await expect(
          Job.create({
            definition: "test_session_not_found_job",
            sessionID: "session_nonexistent999",
            title: "Test Job",
            params: {},
          }),
        ).rejects.toThrow(Job.ParentSessionNotFoundError)
      },
    })
  })

  test("Job created with running status when valid", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_create_valid_job", {
          description: "Test job",
          params: TestParamsSchema,
          output: TestOutputSchema,
          async start(ctx) {
            await ctx.complete({ result: ctx.params.value })
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_create_valid_job",
            sessionID: session.id,
            title: "Test Job",
            params: { value: "hello" },
          })

          expect(job.type).toBe("test_create_valid_job")
          expect(job.status).toBe("running")
          expect(job.params).toEqual({ value: "hello" })
          expect(job.parentSessionID).toBe(session.id)

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })
})

describe("Job.send validation", () => {
  test("InputNotDefinedError thrown when job has no input schema", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_no_input_job", {
          description: "Test job without input",
          params: z.object({}),
          // No input schema
          async start(ctx) {
            await Bun.sleep(1000)
            await ctx.complete()
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_no_input_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          await Bun.sleep(50)

          await expect(
            Job.send({
              jobID: job.id,
              input: { text: "hello" },
            }),
          ).rejects.toThrow(Job.InputNotDefinedError)

          await Job.cancel(job.id)

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("InputValidationError thrown for invalid input", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_input_validation_job", {
          description: "Test job",
          params: z.object({}),
          input: z.object({ count: z.number() }),
          async start(ctx) {
            ctx.onInput(() => {})
            await Bun.sleep(1000)
            await ctx.complete()
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_input_validation_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          await Bun.sleep(50)

          await expect(
            Job.send({
              jobID: job.id,
              input: { count: "not a number" },
            }),
          ).rejects.toThrow(Job.InputValidationError)

          await Job.cancel(job.id)

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("TerminalStateError thrown when job is completed", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_terminal_job", {
          description: "Test job",
          params: z.object({}),
          input: TestInputSchema,
          async start(ctx) {
            await ctx.complete()
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_terminal_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          // Wait for job to complete
          await Bun.sleep(100)

          const updated = await Job.get(job.id)
          expect(updated.status).toBe("completed")

          await expect(
            Job.send({
              jobID: job.id,
              input: { text: "hello" },
            }),
          ).rejects.toThrow(Job.TerminalStateError)

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })
})

describe("Job.wait behavior", () => {
  test("Returns immediately for completed jobs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_wait_completed_job", {
          description: "Test job",
          params: z.object({}),
          output: TestOutputSchema,
          async start(ctx) {
            await ctx.complete({ result: "done" })
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_wait_completed_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          // Wait for job to complete
          await Bun.sleep(100)

          const start = Date.now()
          const result = await Job.wait({ jobID: job.id })
          const elapsed = Date.now() - start

          expect(result.status).toBe("completed")
          expect(elapsed).toBeLessThan(100) // Should be nearly instant

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("Returns on timeout for running jobs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_wait_timeout_job", {
          description: "Test job that takes a long time",
          params: z.object({}),
          async start(ctx) {
            await Bun.sleep(5000)
            await ctx.complete()
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_wait_timeout_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          const start = Date.now()
          const result = await Job.wait({
            jobID: job.id,
            timeout: 100,
          })
          const elapsed = Date.now() - start

          expect(elapsed).toBeLessThan(500)
          expect(result.status).toBe("running")

          await Job.cancel(job.id)

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })

  test("Returns error for failed jobs", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Job } = await import("../../src/job")
        const { JobRegistry } = await import("../../src/job/registry")
        const { Session } = await import("../../src/session")

        JobRegistry.define("test_wait_error_job", {
          description: "Test job that fails",
          params: z.object({}),
          async start(ctx) {
            await ctx.fail("something went wrong")
          },
        })

        const session = await Session.create({ title: "Test Session" })

        try {
          const job = await Job.create({
            definition: "test_wait_error_job",
            sessionID: session.id,
            title: "Test Job",
            params: {},
          })

          const result = await Job.wait({ jobID: job.id })

          expect(result.status).toBe("error")
          expect(result.error).toBe("something went wrong")

          // Cleanup
          const keys = await Storage.list(["job_stream", job.id])
          await Promise.all(keys.map((key) => Storage.remove(key).catch(() => {})))
          await Storage.remove(["job", Instance.project.id, job.id]).catch(() => {})
        } finally {
          await Session.remove(session.id).catch(() => {})
        }
      },
    })
  })
})
