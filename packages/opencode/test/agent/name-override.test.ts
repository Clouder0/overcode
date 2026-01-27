import { expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"

test("agent config ignores options.name override", async () => {
  await using tmp = await tmpdir({
    config: {
      agent: {
        explore: {
          options: {
            name: "explorer-worker",
          },
        },
      },
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agent = await Agent.get("explore")
      expect(agent.name).toBe("explore")
      expect(agent.options.name).toBeUndefined()
    },
  })
})
