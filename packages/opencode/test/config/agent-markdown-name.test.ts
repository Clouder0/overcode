import { expect, test } from "bun:test"

import fs from "fs/promises"
import path from "path"

import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("ignores markdown agent frontmatter name", async () => {
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
      await expect(Config.get()).resolves.toBeDefined()
      const agent = await Agent.get("foo")
      expect(agent.name).toBe("foo")
      expect(agent.options.name).toBeUndefined()
    },
  })
})
