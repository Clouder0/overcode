import path from "path"
import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config/config"

test("loads experimental.llmConcurrency.global config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          experimental: {
            llmConcurrency: {
              global: {
                limits: {
                  "*": 2,
                  "openai/*": 1,
                  "openai/gpt-5": 1,
                },
                staleMs: 123_456,
              },
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
      expect(config.experimental?.llmConcurrency?.global?.limits?.["*"]).toBe(2)
      expect(config.experimental?.llmConcurrency?.global?.limits?.["openai/*"]).toBe(1)
      expect(config.experimental?.llmConcurrency?.global?.limits?.["openai/gpt-5"]).toBe(1)
      expect(config.experimental?.llmConcurrency?.global?.staleMs).toBe(123_456)
    },
  })
})
