import { describe, expect, test } from "bun:test"
import z from "zod"
import { JobRegistry } from "../../src/job/registry"

// These tests use unique names to avoid conflicts with other tests
// since JobRegistry is global and shared across all test files

describe("JobRegistry.define", () => {
  test("registers a job definition", async () => {
    const definition = JobRegistry.define("test_job_reg1", {
      description: "A test job",
      params: z.object({ value: z.string() }),
      async start() {},
    })

    expect(definition.name).toBe("test_job_reg1")
    expect(definition.description).toBe("A test job")
  })

  test("rejects invalid names (uppercase)", async () => {
    expect(() =>
      JobRegistry.define("TestJob", {
        description: "Invalid uppercase name",
        params: z.object({}),
        async start() {},
      }),
    ).toThrow('Invalid job name "TestJob"')
  })

  test("rejects invalid names (starts with number)", async () => {
    expect(() =>
      JobRegistry.define("1job", {
        description: "Invalid number prefix",
        params: z.object({}),
        async start() {},
      }),
    ).toThrow('Invalid job name "1job"')
  })

  test("rejects invalid names (special characters)", async () => {
    expect(() =>
      JobRegistry.define("test-job", {
        description: "Invalid hyphen",
        params: z.object({}),
        async start() {},
      }),
    ).toThrow('Invalid job name "test-job"')

    expect(() =>
      JobRegistry.define("test.job", {
        description: "Invalid dot",
        params: z.object({}),
        async start() {},
      }),
    ).toThrow('Invalid job name "test.job"')

    expect(() =>
      JobRegistry.define("test job", {
        description: "Invalid space",
        params: z.object({}),
        async start() {},
      }),
    ).toThrow('Invalid job name "test job"')
  })

  test("returns existing definition for duplicate names (idempotent)", async () => {
    const first = JobRegistry.define("duplicate_test_reg", {
      description: "First definition",
      params: z.object({}),
      async start() {},
    })

    const second = JobRegistry.define("duplicate_test_reg", {
      description: "Second definition",
      params: z.object({}),
      async start() {},
    })

    // Should return the same definition (first one registered)
    expect(second).toBe(first)
    expect(second.description).toBe("First definition")
  })

  test("accepts valid snake_case names", async () => {
    const job1 = JobRegistry.define("valid_name_reg", {
      description: "Valid snake_case",
      params: z.object({}),
      async start() {},
    })
    expect(job1.name).toBe("valid_name_reg")

    const job2 = JobRegistry.define("a_reg", {
      description: "Single char",
      params: z.object({}),
      async start() {},
    })
    expect(job2.name).toBe("a_reg")

    const job3 = JobRegistry.define("job123_reg", {
      description: "Letters and numbers",
      params: z.object({}),
      async start() {},
    })
    expect(job3.name).toBe("job123_reg")

    const job4 = JobRegistry.define("my_long_job_name_123_reg", {
      description: "Long name with underscores and numbers",
      params: z.object({}),
      async start() {},
    })
    expect(job4.name).toBe("my_long_job_name_123_reg")
  })
})

describe("JobRegistry.get", () => {
  test("returns undefined for unknown name", async () => {
    const result = JobRegistry.get("nonexistent_job_xyz")
    expect(result).toBeUndefined()
  })

  test("returns definition for registered name", async () => {
    JobRegistry.define("get_test_job_reg", {
      description: "Job for get test",
      params: z.object({ id: z.number() }),
      async start() {},
    })

    const result = JobRegistry.get("get_test_job_reg")
    expect(result).toBeDefined()
    expect(result?.name).toBe("get_test_job_reg")
    expect(result?.description).toBe("Job for get test")
  })
})

describe("JobRegistry.list", () => {
  test("returns registered definitions", async () => {
    const initialCount = JobRegistry.list().length

    JobRegistry.define("list_job_a_reg", {
      description: "Job A for list",
      params: z.object({}),
      async start() {},
    })

    JobRegistry.define("list_job_b_reg", {
      description: "Job B for list",
      params: z.object({}),
      async start() {},
    })

    const result = JobRegistry.list()
    const names = result.map((d) => d.name)

    expect(names).toContain("list_job_a_reg")
    expect(names).toContain("list_job_b_reg")
    expect(result.length).toBeGreaterThanOrEqual(initialCount + 2)
  })
})
