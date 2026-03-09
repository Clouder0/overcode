import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const streamCalls: Array<{ providerOptions?: Record<string, Record<string, unknown>> }> = []

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

function model(input?: { id?: string; options?: Record<string, unknown> }) {
  return {
    id: `custom/${input?.id ?? "gpt-5"}`,
    providerID: "custom",
    name: "Test",
    family: "test",
    api: {
      id: input?.id ?? "gpt-5",
      url: "https://example.com/v1",
      npm: "@ai-sdk/openai",
    },
    status: "active",
    headers: {},
    options: input?.options ?? {},
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
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "2025-01-01",
  } as any
}

function agent() {
  return {
    name: "test",
    tools: {},
    options: {},
  } as any
}

test("LLM.stream passes priority service tier for supported models", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await LLM.stream({
        sessionID: "ses_service_tier_supported",
        model: model(),
        agent: agent(),
        user: {
          id: "msg_1",
          serviceTier: "priority",
        } as any,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: {},
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].providerOptions?.openai?.serviceTier).toBe("priority")
    },
  })
})

test("LLM.stream omits explicit auto service tier in normal mode", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await LLM.stream({
        sessionID: "ses_service_tier_auto",
        model: model({ options: { serviceTier: "priority" } }),
        agent: agent(),
        user: {
          id: "msg_1",
          serviceTier: "auto",
        } as any,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: {},
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].providerOptions?.openai?.serviceTier).toBeUndefined()
    },
  })
})

test("LLM.stream strips unsupported priority service tier", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await LLM.stream({
        sessionID: "ses_service_tier_unsupported",
        model: model({ id: "gpt-5-nano" }),
        agent: agent(),
        user: {
          id: "msg_1",
          serviceTier: "priority",
        } as any,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: {},
      })

      expect(streamCalls).toHaveLength(1)
      expect(streamCalls[0].providerOptions?.openai?.serviceTier).toBeUndefined()
    },
  })
})
