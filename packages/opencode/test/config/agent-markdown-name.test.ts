import { expect, test } from "bun:test"

import fs from "fs/promises"
import path from "path"

import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("rejects markdown agent frontmatter name", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const agentDir = path.join(dir, ".opencode", "agent")
      await fs.mkdir(agentDir, { recursive: true })
      await Bun.write(path.join(agentDir, "foo.md"), ["---", "name: bar", "---", "", "prompt"].join("\n"))
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const error = await Config.get().then(
        () => undefined,
        (e) => e,
      )

      expect(error).toBeDefined()
      expect(Config.InvalidError.isInstance(error)).toBe(true)

      if (Config.InvalidError.isInstance(error)) {
        expect(error.data.path).toContain("foo.md")
        expect(error.data.message).toContain('frontmatter must not set "name"')
      }
    },
  })
})
