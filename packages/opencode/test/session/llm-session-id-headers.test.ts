import { afterAll, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const streamCalls: Array<{ headers?: Record<string, string> }> = []

// Only mock external dependencies that don't affect other tests
mock.module("ai", () => ({
  streamText: (args: any) => {
    streamCalls.push(args)
    return {} as any
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
  // Use spyOn instead of mock.module to avoid affecting other tests
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

test("adds x-session-id header for @ai-sdk/openai models", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_0123456789ABCDEF0123456789"
      const upstreamSessionID = sessionID.replace(/^ses_/, "sess_")

      await LLM.stream({
        sessionID,
        model: {
          id: "custom/gpt-5.1-codex",
          providerID: "custom",
          name: "Test",
          family: "test",
          api: {
            id: "gpt-5.1-codex",
            url: "https://example.com/v1",
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
          name: "test",
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

      expect(streamCalls).toHaveLength(1)

      const call = streamCalls[0]
      expect(call.headers?.["x-session-id"]).toBe(upstreamSessionID)
      expect(call.headers?.["session_id"]).toBeUndefined()
    },
  })
})

test("does not add x-session-id/session_id for non-openai models", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sessionID = "ses_0123456789ABCDEF0123456789"

      await LLM.stream({
        sessionID,
        model: {
          id: "custom/claude",
          providerID: "custom",
          name: "Test",
          family: "test",
          api: {
            id: "claude-3-5-sonnet-20241022",
            url: "https://example.com",
            npm: "@ai-sdk/anthropic",
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
          name: "test",
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

      expect(streamCalls).toHaveLength(1)

      const call = streamCalls[0]
      expect(call.headers?.["x-session-id"]).toBeUndefined()
      expect(call.headers?.["session_id"]).toBeUndefined()
    },
  })
})
