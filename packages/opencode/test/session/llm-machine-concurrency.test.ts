import path from "path"
import fs from "fs/promises"
import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"

let finish: (() => void) | undefined

mock.module("ai", () => ({
  streamText: (_args: any) => {
    const done = new Promise<string>((resolve) => {
      finish = () => resolve("ok")
    })

    return {
      text: done,
      fullStream: (async function* () {
        await done
        yield undefined as any
      })(),
    } as any
  },
  wrapLanguageModel: ({ model }: any) => model,
}))

// Import modules that we'll spy on (not mock.module to avoid affecting other tests)
const { Config } = await import("../../src/config/config")
const { Plugin } = await import("../../src/plugin")
const { Provider } = await import("../../src/provider/provider")
const { ToolRegistry } = await import("../../src/tool/registry")

let configSpy: ReturnType<typeof spyOn>
let pluginSpy: ReturnType<typeof spyOn>
let providerGetLanguageSpy: ReturnType<typeof spyOn>
let providerGetProviderSpy: ReturnType<typeof spyOn>
let toolRegistrySpy: ReturnType<typeof spyOn>

beforeAll(() => {
  configSpy = spyOn(Config, "get").mockResolvedValue({
    experimental: {
      llmConcurrency: {
        global: {
          limits: {
            "*": 10,
          },
        },
      },
    },
  } as any)
  pluginSpy = spyOn(Plugin, "trigger").mockImplementation(async (_name: any, _input: any, output: any) => output)
  providerGetLanguageSpy = spyOn(Provider, "getLanguage").mockResolvedValue({} as any)
  providerGetProviderSpy = spyOn(Provider, "getProvider").mockResolvedValue({ id: "openai", options: {} } as any)
  toolRegistrySpy = spyOn(ToolRegistry, "enabled").mockResolvedValue({})
})

afterAll(() => {
  configSpy?.mockRestore()
  pluginSpy?.mockRestore()
  providerGetLanguageSpy?.mockRestore()
  providerGetProviderSpy?.mockRestore()
  toolRegistrySpy?.mockRestore()
  mock.restore()
})

beforeEach(() => {
  finish = undefined
})

const { LLM } = await import("../../src/session/llm")

test("LLM.stream creates and releases machine lease", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const leasePath = path.join(Global.Path.state, "llm-concurrency", "leases")

      const before = await fs.readdir(leasePath).catch(() => [] as string[])
      expect(before.some((x) => x.startsWith("lease_"))).toBe(false)

      const stream = await LLM.stream({
        sessionID: "ses_test",
        model: {
          id: "gpt-5",
          providerID: "openai",
          name: "Test",
          family: "test",
          api: {
            id: "gpt-5",
            url: "https://example.com",
            npm: "@ai-sdk/openai",
          },
          status: "active",
          headers: {},
          options: {},
          cost: {
            input: 0,
            output: 0,
            cache: {
              read: 0,
              write: 0,
            },
          },
          limit: {
            context: 10_000,
            output: 1_000,
          },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          release_date: "2025-01-01",
        } as any,
        agent: {
          name: "build",
          tools: {},
          options: {},
        } as any,
        user: {
          id: "msg_1",
        } as any,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: {},
      })

      const during = await fs.readdir(leasePath).catch(() => [] as string[])
      expect(during.some((x) => x.startsWith("lease_"))).toBe(true)

      if (!finish) {
        throw new Error("expected mocked streamText to set finish")
      }
      finish()
      await stream.text

      const after = await fs.readdir(leasePath).catch(() => [] as string[])
      expect(after.some((x) => x.startsWith("lease_"))).toBe(false)
    },
  })
})
