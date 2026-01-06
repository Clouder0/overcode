import { expect, test } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"

test("agent config rejects options.name override", async () => {
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
      let threw = false
      try {
        await Agent.get("explore")
      } catch (e) {
        threw = true
        expect(String(e)).toContain("must not set")
      }

      expect(threw).toBe(true)
    },
  })
})
