import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"
import { LSP } from "../../src/lsp"
import { SessionStatus } from "../../src/session/status"

test("quiescent idle pruning does not evict while session is busy", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          experimental: {
            lsp: {
              maxServers: 8,
              idleMs: 1000,
              protectedRatio: 0.8,
            },
          },
          lsp: {
            fake: {
              command: [process.execPath, serverPath],
              extensions: [".foo"],
            },
          },
        }),
      )
      await Bun.write(path.join(dir, "a.foo"), "hello")
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Force config + LSP init in this instance.
      await Config.get()
      await LSP.touchFile(path.join(tmp.path, "a.foo"), false)

      const before = await LSP.status()
      expect(before.length).toBe(1)

      SessionStatus.set("ses_test", { type: "busy" })
      await Bun.sleep(1200)

      const during = await LSP.status()
      expect(during.length).toBe(1)

      SessionStatus.set("ses_test", { type: "idle" })
      await Bun.sleep(1200)

      const after = await LSP.status()
      expect(after.length).toBe(0)
    },
  })
})
