import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"

test("loads experimental.lsp config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          experimental: {
            lsp: {
              maxServers: 7,
              idleMs: 600_000,
              protectedRatio: 0.75,
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.experimental?.lsp?.maxServers).toBe(7)
      expect(config.experimental?.lsp?.idleMs).toBe(600_000)
      expect(config.experimental?.lsp?.protectedRatio).toBe(0.75)
    },
  })
})

test("rejects invalid experimental.lsp config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          experimental: {
            lsp: {
              maxServers: 0,
              idleMs: 500,
              protectedRatio: 2,
            },
          },
        }),
      )
    },
  })

  await expect(
    Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.get()
      },
    }),
  ).rejects.toThrow()
})
