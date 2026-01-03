import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const streamCalls: Array<{ activeTools?: string[]; tools?: Record<string, unknown> }> = []

mock.module("ai", () => ({
  streamText: (args: any) => {
    streamCalls.push(args)
    return {} as any
  },
  wrapLanguageModel: ({ model }: any) => model,
}))

const { Config } = await import("../../src/config/config")
const { Plugin } = await import("../../src/plugin")
const { Provider } = await import("../../src/provider/provider")
const { ToolRegistry } = await import("../../src/tool/registry")
const { SessionToolOverrides } = await import("../../src/session/tool-overrides")

let configSpy: ReturnType<typeof spyOn>
let pluginSpy: ReturnType<typeof spyOn>
let providerGetLanguageSpy: ReturnType<typeof spyOn>
let providerGetProviderSpy: ReturnType<typeof spyOn>
let toolRegistrySpy: ReturnType<typeof spyOn>

beforeAll(() => {
  configSpy = spyOn(Config, "get").mockResolvedValue({ experimental: {} } as any)
  pluginSpy = spyOn(Plugin, "trigger").mockImplementation(async (_name: any, _input: any, output: any) => output)
  providerGetLanguageSpy = spyOn(Provider, "getLanguage").mockResolvedValue({} as any)
  providerGetProviderSpy = spyOn(Provider, "getProvider").mockResolvedValue({ options: {} } as any)
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
  streamCalls.length = 0
})

const { LLM } = await import("../../src/session/llm")

test("session tool overrides affect LLM tool filtering", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_tool_overrides_test"
      await SessionToolOverrides.clear(sessionID)

      const model = {
        id: "custom/test",
        providerID: "custom",
        api: {
          id: "claude-3-5-sonnet-20241022",
          npm: "@ai-sdk/anthropic",
        },
        headers: {},
        options: {},
        capabilities: { temperature: false },
        limit: { output: 1_000 },
      } as any

      const agent = {
        name: "test",
        options: {},
        permission: [],
      } as any

      const user = {
        id: "msg_1",
        tools: {
          heavy: false,
          "chrome_devtools_*": false,
        },
      } as any

      const tools = () => ({
        heavy: {} as any,
        chrome_devtools_screenshot: {} as any,
        invalid: {} as any,
      })

      await LLM.stream({
        sessionID,
        model,
        agent,
        user,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: tools(),
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].activeTools).not.toContain("heavy")
      expect(streamCalls[0].activeTools).not.toContain("chrome_devtools_screenshot")

      streamCalls.length = 0
      await SessionToolOverrides.enable(sessionID, ["heavy", "chrome_devtools_*"])

      await LLM.stream({
        sessionID,
        model,
        agent,
        user,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: tools(),
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].activeTools).toContain("heavy")
      expect(streamCalls[0].activeTools).toContain("chrome_devtools_screenshot")

      streamCalls.length = 0
      SessionToolOverrides.evict(sessionID)

      await LLM.stream({
        sessionID,
        model,
        agent,
        user,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: tools(),
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].activeTools).toContain("heavy")
      expect(streamCalls[0].activeTools).toContain("chrome_devtools_screenshot")

      await SessionToolOverrides.clear(sessionID)
    },
  })
})
