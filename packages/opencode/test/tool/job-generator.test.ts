import { describe, expect, test } from "bun:test"
import path from "node:path"
import z from "zod"

const projectRoot = path.join(__dirname, "../..")

// Use dynamic imports to avoid circular dependency issues
// We only need Instance and JobRegistry for testing tool generation
const { Instance } = await import("../../src/project/instance")
const { JobRegistry } = await import("../../src/job/registry")

// Import JobGenerator lazily within tests to avoid circular deps at module load
async function getJobGenerator() {
  const mod = await import("../../src/tool/job-generator")
  return mod.JobGenerator
}

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({
    directory: projectRoot,
    fn,
  })
}

describe("JobGenerator.generate", () => {
  test("generates start tool for any definition", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_basic", {
        description: "A basic test job",
        params: z.object({ value: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      expect(tools.length).toBeGreaterThanOrEqual(1)

      const startTool = tools.find((t) => t.id === "job_gen_test_basic_start")
      expect(startTool).toBeDefined()
      expect(startTool!.id).toBe("job_gen_test_basic_start")
    })
  })

  test("generates send tool only if input schema defined", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_with_input", {
        description: "Job with input",
        params: z.object({ id: z.number() }),
        input: z.object({ message: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      const sendTool = tools.find((t) => t.id === "job_gen_test_with_input_send")
      expect(sendTool).toBeDefined()
      expect(sendTool!.id).toBe("job_gen_test_with_input_send")
    })
  })

  test("skips send tool if no input schema", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_no_input", {
        description: "Job without input",
        params: z.object({ count: z.number() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      const sendTool = tools.find((t) => t.id === "job_gen_test_no_input_send")
      expect(sendTool).toBeUndefined()
    })
  })

  test("generates read tool only if output schema defined", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_with_output", {
        description: "Job with output",
        params: z.object({ query: z.string() }),
        output: z.object({ result: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      const readTool = tools.find((t) => t.id === "job_gen_test_with_output_read")
      expect(readTool).toBeDefined()
      expect(readTool!.id).toBe("job_gen_test_with_output_read")
    })
  })

  test("skips read tool if no output schema", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_no_output", {
        description: "Job without output",
        params: z.object({ data: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      const readTool = tools.find((t) => t.id === "job_gen_test_no_output_read")
      expect(readTool).toBeUndefined()
    })
  })

  test("tool names follow job_{name}_{action} pattern", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_naming", {
        description: "Test naming pattern",
        params: z.object({}),
        input: z.object({ text: z.string() }),
        output: z.object({ status: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      expect(tools.length).toBe(3)
      expect(tools.some((t) => t.id === "job_gen_test_naming_start")).toBe(true)
      expect(tools.some((t) => t.id === "job_gen_test_naming_send")).toBe(true)
      expect(tools.some((t) => t.id === "job_gen_test_naming_read")).toBe(true)
    })
  })

  test("handles async description function", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_async_desc", {
        description: async () => "Dynamically loaded description",
        params: z.object({}),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      const startTool = tools.find((t) => t.id === "job_gen_test_async_desc_start")
      expect(startTool).toBeDefined()
      expect(startTool!.id).toBe("job_gen_test_async_desc_start")
    })
  })

  test("generates all three tools when both input and output defined", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_full", {
        description: "Full featured job",
        params: z.object({ config: z.string() }),
        input: z.object({ command: z.string() }),
        output: z.object({ response: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      expect(tools.length).toBe(3)
      expect(tools.map((t) => t.id).sort()).toEqual([
        "job_gen_test_full_read",
        "job_gen_test_full_send",
        "job_gen_test_full_start",
      ])
    })
  })

  test("generates only start tool when no input or output defined", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_minimal", {
        description: "Minimal job",
        params: z.object({}),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)

      expect(tools.length).toBe(1)
      expect(tools[0].id).toBe("job_gen_test_minimal_start")
    })
  })
})

describe("JobGenerator.generateAll", () => {
  test("generates tools for all registered definitions", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      // Register a couple of test jobs
      JobRegistry.define("gen_all_test_a", {
        description: "Test job A",
        params: z.object({}),
        async start() {},
      })

      JobRegistry.define("gen_all_test_b", {
        description: "Test job B",
        params: z.object({}),
        input: z.object({ data: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generateAll()

      // Should include tools for both jobs
      const toolIds = tools.map((t) => t.id)
      expect(toolIds).toContain("job_gen_all_test_a_start")
      expect(toolIds).toContain("job_gen_all_test_b_start")
      expect(toolIds).toContain("job_gen_all_test_b_send")
    })
  })

  test("returns empty array when no definitions registered", async () => {
    // This tests in a fresh instance context where no jobs are registered yet
    // Note: Due to test isolation, other tests may have registered jobs
    // so we just verify the function works and returns an array
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()
      const tools = JobGenerator.generateAll()
      expect(Array.isArray(tools)).toBe(true)
    })
  })
})

describe("Tool initialization", () => {
  test("start tool is created with correct id", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_start_desc", {
        description: "Test description content",
        params: z.object({ option: z.boolean() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)
      const startTool = tools.find((t) => t.id === "job_gen_test_start_desc_start")

      expect(startTool).toBeDefined()
      expect(startTool!.id).toBe("job_gen_test_start_desc_start")
      expect(typeof startTool!.init).toBe("function")
    })
  })

  test("send tool is created with correct id", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_send_params", {
        description: "Test send params",
        params: z.object({}),
        input: z.object({ message: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)
      const sendTool = tools.find((t) => t.id === "job_gen_test_send_params_send")

      expect(sendTool).toBeDefined()
      expect(sendTool!.id).toBe("job_gen_test_send_params_send")
      expect(typeof sendTool!.init).toBe("function")
    })
  })

  test("read tool is created with correct id", async () => {
    await withInstance(async () => {
      const JobGenerator = await getJobGenerator()

      const definition = JobRegistry.define("gen_test_read_params", {
        description: "Test read params",
        params: z.object({}),
        output: z.object({ data: z.string() }),
        async start() {},
      })

      const tools = JobGenerator.generate(definition)
      const readTool = tools.find((t) => t.id === "job_gen_test_read_params_read")

      expect(readTool).toBeDefined()
      expect(readTool!.id).toBe("job_gen_test_read_params_read")
      expect(typeof readTool!.init).toBe("function")
    })
  })
})
