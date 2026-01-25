import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp"

function servers(input: { count: number; serverPath: string }) {
  const result: Record<string, { command: string[]; extensions: string[] }> = {}
  for (const i of Array.from({ length: input.count }).keys()) {
    result[`fake_${i}`] = {
      command: [process.execPath, input.serverPath],
      extensions: [".foo"],
    }
  }
  return result
}

test("does not enforce cap when experimental.lsp.maxServers is unset", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          // NOTE: omit experimental.lsp.maxServers to mean unlimited.
          lsp: servers({ count: 13, serverPath }),
        }),
      )
      await Bun.write(path.join(dir, "a.foo"), "hello")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.get()
      await LSP.touchFile(path.join(tmp.path, "a.foo"), false)

      const status = await LSP.status()
      expect(status.length).toBe(13)

      await Instance.dispose()
    },
  })
})

test("enforces cap when experimental.lsp.maxServers is set", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          experimental: {
            lsp: {
              maxServers: 5,
            },
          },
          lsp: servers({ count: 13, serverPath }),
        }),
      )
      await Bun.write(path.join(dir, "a.foo"), "hello")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Config.get()
      await LSP.touchFile(path.join(tmp.path, "a.foo"), false)

      // Eviction may be deferred until leases are released.
      for (const _ of Array.from({ length: 100 })) {
        const count = (await LSP.status()).length
        if (count <= 5) break
        await Bun.sleep(50)
      }

      expect((await LSP.status()).length).toBeLessThanOrEqual(5)

      await Instance.dispose()
    },
  })
})
