import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { APICallError } from "ai"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { Config } from "../../src/config/config"
import { tmpdir } from "../fixture/fixture"
import { SessionCompaction } from "../../src/session/compaction"
import { Agent } from "../../src/agent/agent"
import { Provider } from "../../src/provider/provider"
import { Plugin } from "../../src/plugin"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.processor compact-on-context-length", () => {
  test("returns compact and records fallback error", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfg.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "test",
          model: { providerID: "openai", modelID: "gpt-5" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text: "hello",
        })

        const assistantID = Identifier.ascending("message")
        const assistant: MessageV2.Assistant = {
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-5",
          providerID: "openai",
          mode: "test",
          agent: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now },
        }
        await Session.updateMessage(assistant)

        const apiError = new APICallError({
          message: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
          url: "https://example.invalid",
          requestBodyValues: {},
          statusCode: 400,
          responseHeaders: {},
          responseBody: JSON.stringify({
            error: {
              message: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          }),
          isRetryable: false,
        })

        const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
          throw apiError
        })

        const model = { id: "test", providerID: "openai", limit: { context: 8192, output: 4096 } } as any
        const processor = SessionProcessor.create({
          assistantMessage: assistant,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })

        const result = await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: { name: "test" } as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {},
        } as any)

        llmSpy.mockRestore()

        expect(result).toBe("compact")
        expect(processor.compactionRequest?.reason).toBe("context_length")
        expect(processor.compactionRequest?.fallbackError).toBeDefined()
        expect(processor.message.error).toBeUndefined()
      },
    })
  })

  test("compacts on OpenAI streamed error chunks", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfg.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "test",
          model: { providerID: "openai", modelID: "gpt-5" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text: "hello",
        })

        const assistantID = Identifier.ascending("message")
        const assistant: MessageV2.Assistant = {
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-5",
          providerID: "openai",
          mode: "test",
          agent: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now },
        }
        await Session.updateMessage(assistant)

        const streamError = {
          type: "error",
          sequence_number: 2,
          error: {
            type: "invalid_request_error",
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
            param: "input",
          },
        }

        const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
          async function* fullStream() {
            yield { type: "error", error: streamError }
          }

          return {
            fullStream: fullStream(),
          } as any
        })

        const model = { id: "test", providerID: "openai", limit: { context: 8192, output: 4096 } } as any
        const processor = SessionProcessor.create({
          assistantMessage: assistant,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })

        const result = await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: { name: "test" } as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {},
        } as any)

        llmSpy.mockRestore()

        expect(result).toBe("compact")
        expect(processor.compactionRequest?.reason).toBe("context_length")
      },
    })
  })

  test("does not compact when the user prompt is a replay", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfg = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfg.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "test",
          model: { providerID: "openai", modelID: "gpt-5" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text: "hello",
          metadata: {
            opencode: {
              replay: true,
            },
          },
        })

        const assistantID = Identifier.ascending("message")
        const assistant: MessageV2.Assistant = {
          id: assistantID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-5",
          providerID: "openai",
          mode: "test",
          agent: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now },
        }
        await Session.updateMessage(assistant)

        const apiError = new APICallError({
          message: "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
          url: "https://example.invalid",
          requestBodyValues: {},
          statusCode: 400,
          responseHeaders: {},
          responseBody: "{}",
          isRetryable: false,
        })

        const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
          throw apiError
        })

        const model = { id: "test", providerID: "openai", limit: { context: 8192, output: 4096 } } as any
        const processor = SessionProcessor.create({
          assistantMessage: assistant,
          sessionID: session.id,
          model,
          abort: new AbortController().signal,
        })

        const result = await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: { name: "test" } as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {},
        } as any)

        llmSpy.mockRestore()

        expect(result).toBe("stop")
        expect(processor.compactionRequest).toBeUndefined()
        expect(processor.message.error?.name).toBe("APIError")
      },
    })
  })
})

describe("session.compaction replay", () => {
  test("replays the last unanswered user prompt when auto", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pluginSpy = spyOn(Plugin, "trigger").mockImplementation(
          async (_name: any, _input: any, output: any) => output,
        )
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({ id: "dummy", providerID: "dummy" } as any)
        const agentSpy = spyOn(Agent, "get").mockResolvedValue({
          name: "compaction",
          options: {},
          permission: [],
        } as any)

        let captured: any
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            async process(input: any) {
              captured = input
              return "continue"
            },
          } as any
        })

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            pluginSpy.mockRestore()
            providerSpy.mockRestore()
            agentSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "please do the thing",
        })

        const assistant1: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "test",
          agent: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1 },
        }
        await Session.updateMessage(assistant1)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant1.id,
          sessionID: session.id,
          type: "reasoning",
          text: "lots of hidden thinking",
          time: { start: now + 1 },
        })

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        const history = await Session.messages({ sessionID: session.id })
        await SessionCompaction.process({
          parentID: compactReq.id,
          messages: history,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: true,
        })

        expect(captured).toBeDefined()
        const hasReasoning = (captured.messages ?? []).some((m: any) => {
          const content = m.content
          if (!Array.isArray(content)) return false
          return content.some((p: any) => p && p.type === "reasoning")
        })
        expect(hasReasoning).toBe(false)

        const after = await Session.messages({ sessionID: session.id })
        const replay = after
          .filter((m) => m.info.role === "user")
          .flatMap((m) => m.parts)
          .find((p) => p.type === "text" && (p.metadata as any)?.opencode?.replay === true)

        expect(replay).toBeDefined()
        if (!replay || replay.type !== "text") throw new Error("expected replay text part")
        expect(replay.synthetic).toBe(true)
        expect(replay.text).toBe("please do the thing")
      },
    })
  })

  test("replays a file-only user prompt when auto", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pluginSpy = spyOn(Plugin, "trigger").mockImplementation(
          async (_name: any, _input: any, output: any) => output,
        )
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({ id: "dummy", providerID: "dummy" } as any)
        const agentSpy = spyOn(Agent, "get").mockResolvedValue({
          name: "compaction",
          options: {},
          permission: [],
        } as any)

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            async process() {
              return "continue"
            },
          } as any
        })

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            pluginSpy.mockRestore()
            providerSpy.mockRestore()
            agentSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "file",
          mime: "text/plain",
          filename: "note.txt",
          url: "file:///note.txt",
        })

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        const history = await Session.messages({ sessionID: session.id })
        await SessionCompaction.process({
          parentID: compactReq.id,
          messages: history,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: true,
        })

        const after = await Session.messages({ sessionID: session.id })
        const replay = after
          .filter((m) => m.info.role === "user")
          .flatMap((m) => m.parts)
          .find((p) => p.type === "text" && (p.metadata as any)?.opencode?.replay === true)

        expect(replay).toBeDefined()
        if (!replay || replay.type !== "text") throw new Error("expected replay text part")
        expect(replay.synthetic).toBe(true)
        expect(replay.text.length).toBeGreaterThan(0)
        expect(replay.text).toContain("note.txt")
      },
    })
  })

  test("replays a message-only user prompt when auto", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pluginSpy = spyOn(Plugin, "trigger").mockImplementation(
          async (_name: any, _input: any, output: any) => output,
        )
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({ id: "dummy", providerID: "dummy" } as any)
        const agentSpy = spyOn(Agent, "get").mockResolvedValue({
          name: "compaction",
          options: {},
          permission: [],
        } as any)

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            async process() {
              return "continue"
            },
          } as any
        })

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            pluginSpy.mockRestore()
            providerSpy.mockRestore()
            agentSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "message",
          direction: "incoming",
          peer: "ses_agent",
          peerType: "agent",
          text: "hi from agent",
          time: { created: now },
        })

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        const history = await Session.messages({ sessionID: session.id })
        await SessionCompaction.process({
          parentID: compactReq.id,
          messages: history,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: true,
        })

        const after = await Session.messages({ sessionID: session.id })
        const replay = after
          .filter((m) => m.info.role === "user")
          .flatMap((m) => m.parts)
          .find((p) => p.type === "text" && (p.metadata as any)?.opencode?.replay === true)

        expect(replay).toBeDefined()
        if (!replay) throw new Error("expected replay part")

        const msg = after.find((m) => m.info.id === replay.messageID)
        expect(msg).toBeDefined()
        if (!msg) throw new Error("expected replay message")

        const echoed = msg.parts.some((p) => p.type === "message" && p.text === "hi from agent")
        expect(echoed).toBe(true)
      },
    })
  })

  test("falls back to continue prompt when last user was already answered", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const pluginSpy = spyOn(Plugin, "trigger").mockImplementation(
          async (_name: any, _input: any, output: any) => output,
        )
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({ id: "dummy", providerID: "dummy" } as any)
        const agentSpy = spyOn(Agent, "get").mockResolvedValue({
          name: "compaction",
          options: {},
          permission: [],
        } as any)

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            async process() {
              return "continue"
            },
          } as any
        })

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            pluginSpy.mockRestore()
            providerSpy.mockRestore()
            agentSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "already answered",
        })

        const assistant1: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "test",
          agent: "test",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1 },
          finish: "end_turn",
        }
        await Session.updateMessage(assistant1)

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "test",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        const history = await Session.messages({ sessionID: session.id })
        await SessionCompaction.process({
          parentID: compactReq.id,
          messages: history,
          sessionID: session.id,
          abort: new AbortController().signal,
          auto: true,
        })

        const after = await Session.messages({ sessionID: session.id })
        const continueText = after
          .filter((m) => m.info.role === "user")
          .flatMap((m) => m.parts)
          .find((p) => p.type === "text" && p.text === "Continue if you have next steps")

        expect(continueText).toBeDefined()
      },
    })
  })
})
