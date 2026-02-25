import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"

describe("bus disposal", () => {
  test("disposal does not create unhandled promise rejections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-bus-dispose-"))
    try {
      const failures: unknown[] = []
      const onUnhandled = (error: unknown) => {
        failures.push(error)
      }
      process.on("unhandledRejection", onUnhandled)

      await Instance.provide({
        directory: dir,
        fn: async () => {
          Bus.subscribeAll(() => Promise.reject(new Error("boom")))
          await Instance.dispose()
        },
      })

      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      process.off("unhandledRejection", onUnhandled)

      expect(failures).toHaveLength(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
