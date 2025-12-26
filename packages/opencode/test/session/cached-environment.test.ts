import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"

describe("SessionPrompt.getCachedEnvironment", () => {
  test("dedupes concurrent loads per session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let calls = 0
          const load = async () => {
            calls++
            await new Promise((resolve) => setTimeout(resolve, 10))
            return ["env"]
          }

          const a = SessionPrompt.getCachedEnvironment("ses_test", load)
          const b = SessionPrompt.getCachedEnvironment("ses_test", load)

          expect(a).toBe(b)

          const [av, bv] = await Promise.all([a, b])

          expect(calls).toBe(1)
          expect(av).toEqual(["env"])
          expect(bv).toEqual(["env"])
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("clearCachedEnvironment allows a subsequent reload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let calls = 0
          const load = async () => {
            calls++
            return ["env"]
          }

          await SessionPrompt.getCachedEnvironment("ses_test_clear", load)
          SessionPrompt.clearCachedEnvironment("ses_test_clear")
          await SessionPrompt.getCachedEnvironment("ses_test_clear", load)

          expect(calls).toBe(2)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("evicts least recently used entries over 16", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let calls = 0
          const load = async () => {
            calls++
            return ["env"]
          }

          for (let index = 0; index < 16; index++) {
            await SessionPrompt.getCachedEnvironment(`ses_${index}`, load)
          }

          await SessionPrompt.getCachedEnvironment("ses_0", load)
          await SessionPrompt.getCachedEnvironment("ses_16", load)

          const before = calls
          await SessionPrompt.getCachedEnvironment("ses_1", load)

          expect(calls).toBe(before + 1)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("drops cached rejection to allow retries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let calls = 0
          const load = async () => {
            calls++
            if (calls === 1) {
              throw new Error("fail")
            }
            return ["env"]
          }

          await expect(SessionPrompt.getCachedEnvironment("ses_fail", load)).rejects.toThrow("fail")
          const env = await SessionPrompt.getCachedEnvironment("ses_fail", load)

          expect(env).toEqual(["env"])
          expect(calls).toBe(2)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("pins waiting sessions and does not evict them", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let pinnedCalls = 0
          const loadPinned = async () => {
            pinnedCalls++
            return ["env"]
          }

          let idleCalls = 0
          const loadIdle = async () => {
            idleCalls++
            return ["env"]
          }

          await SessionPrompt.getCachedEnvironment("ses_waiting", loadPinned)
          SessionStatus.set("ses_waiting", {
            type: "waiting",
            sources: [],
            timeout: 1,
            mode: "all",
            time: { created: Date.now() },
          })

          for (let index = 0; index < 20; index++) {
            await SessionPrompt.getCachedEnvironment(`ses_idle_${index}`, loadIdle)
          }

          await SessionPrompt.getCachedEnvironment("ses_waiting", loadPinned)

          expect(pinnedCalls).toBe(1)
          expect(idleCalls).toBe(20)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("moves pinned sessions into idle LRU when idle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let pinnedCalls = 0
          const loadPinned = async () => {
            pinnedCalls++
            return ["env"]
          }

          const loadIdle = async () => {
            return ["env"]
          }

          await SessionPrompt.getCachedEnvironment("ses_demote", loadPinned)
          SessionStatus.set("ses_demote", {
            type: "waiting",
            sources: [],
            timeout: 1,
            mode: "all",
            time: { created: Date.now() },
          })

          SessionStatus.set("ses_demote", { type: "idle" })

          for (let index = 0; index < 16; index++) {
            await SessionPrompt.getCachedEnvironment(`ses_demote_idle_${index}`, loadIdle)
          }

          await SessionPrompt.getCachedEnvironment("ses_demote", loadPinned)
          expect(pinnedCalls).toBe(2)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("cancel on idle does not clear environment cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-cache-"))

    try {
      await Instance.provide({
        directory: dir,
        fn: async () => {
          let calls = 0
          const load = async () => {
            calls++
            return ["env"]
          }

          await SessionPrompt.getCachedEnvironment("ses_cancel", load)
          SessionPrompt.cancel("ses_cancel")
          await SessionPrompt.getCachedEnvironment("ses_cancel", load)

          expect(calls).toBe(1)
        },
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
