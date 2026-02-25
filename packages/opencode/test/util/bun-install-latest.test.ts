import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { BunProc } from "../../src/bun"
import { Global } from "../../src/global"

describe("BunProc.install", () => {
  test("latest uses cached pinned version when present", async () => {
    const pkg = "bad name " + Math.random().toString(36).slice(2)
    const mod = path.join(Global.Path.cache, "node_modules", pkg)
    const pkgjson = path.join(Global.Path.cache, "package.json")

    const before = await Bun.file(pkgjson)
      .text()
      .catch(() => undefined)

    try {
      await fs.mkdir(mod, { recursive: true })
      await Bun.write(
        path.join(mod, "package.json"),
        JSON.stringify(
          {
            name: pkg,
            version: "0.0.0",
          },
          null,
          2,
        ),
      )

      const parsed = before ? JSON.parse(before) : { dependencies: {} }
      const dependencies = parsed.dependencies ?? {}
      parsed.dependencies = {
        ...dependencies,
        [pkg]: "0.0.0",
      }
      await Bun.write(pkgjson, JSON.stringify(parsed, null, 2))

      const result = await BunProc.install(pkg, "latest")
      expect(result.endsWith(pkg)).toBeTrue()
    } finally {
      await fs.rm(mod, { recursive: true, force: true })

      await (before === undefined ? fs.rm(pkgjson, { force: true }).catch(() => {}) : Bun.write(pkgjson, before))
    }
  })
})
