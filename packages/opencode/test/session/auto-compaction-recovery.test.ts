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
import { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCPD } from "../../src/session/cpd"
import { SessionSummary } from "../../src/session/summary"

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

describe("legacy replay prompts", () => {
  test("treats synthetic replay text as user-relevant", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          limit: {
            context: 2,
            output: 1,
          },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          synthetic: true,
          text: "please do the thing",
          metadata: {
            opencode: {
              replay: true,
              sourceMessageID: "msg_source",
            },
          },
          time: {
            start: now,
            end: now,
          },
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const assistant = msgs.find((m) => m.info.role === "assistant" && (m.info as any).parentID === user.id)
        expect(assistant).toBeDefined()
      },
    })
  })
})

describe("session.prompt context maintenance", () => {
  test("marks incomplete reasoning-only attempts as omitted before next continuation", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
          },
          limit: {
            context: 100_000,
            output: 1_000,
          },
        } as any)

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()

        const user1 = Identifier.ascending("message")
        await Session.updateMessage({
          id: user1,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user1,
          type: "text",
          text: "first",
        })

        const assistant1 = Identifier.ascending("message")
        await Session.updateMessage({
          id: assistant1,
          sessionID: session.id,
          role: "assistant",
          parentID: user1,
          modelID: "dummy",
          providerID: "dummy",
          mode: "test",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          summary: false,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, completed: now },
          finish: "stop",
        } as any)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: assistant1,
          type: "text",
          text: "ok",
        })

        const user2 = Identifier.ascending("message")
        await Session.updateMessage({
          id: user2,
          sessionID: session.id,
          role: "user",
          time: { created: now + 1 },
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user2,
          type: "text",
          text: "second",
        })

        const calls = { user2: 0 }

        spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage as MessageV2.Assistant

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            process: async (args: any) => {
              if (args.user.id === user2) {
                calls.user2 += 1
                if (calls.user2 === 1) {
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    sessionID: session.id,
                    messageID: assistant.id,
                    type: "reasoning",
                    text: "partial thinking",
                    time: { start: Date.now(), end: Date.now() },
                  })
                  assistant.time.completed = Date.now()
                  await Session.updateMessage(assistant)

                  processor.compactionRequest = {
                    reason: "context_length",
                    fallbackError: {
                      name: "APIError",
                      data: {
                        message:
                          "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
                        responseBody: JSON.stringify({
                          error: {
                            message:
                              "This model's maximum context length is 8192 tokens, however you requested 9000 tokens.",
                            code: "context_length_exceeded",
                          },
                        }),
                      },
                    },
                  }
                  return "compact"
                }

                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "text",
                  text: "done",
                })
                assistant.finish = "stop"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "stop"
              }

              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "text",
                text: "third",
              })
              assistant.finish = "stop"
              assistant.time.completed = Date.now()
              await Session.updateMessage(assistant)
              return "stop"
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        const user3 = Identifier.ascending("message")
        await Session.updateMessage({
          id: user3,
          sessionID: session.id,
          role: "user",
          time: { created: now + 2 },
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user3,
          type: "text",
          text: "third",
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const attempts = msgs.filter((m) => m.info.role === "assistant" && (m.info as any).parentID === user2)
        expect(attempts.length).toBeGreaterThanOrEqual(2)

        const firstAttempt = attempts.find((m) => !(m.info as any).finish)
        expect(firstAttempt).toBeDefined()

        const reasoning = firstAttempt!.parts.find((p) => p.type === "reasoning") as MessageV2.ReasoningPart | undefined
        expect(reasoning).toBeDefined()
        expect(reasoning!.ignored).toBe(true)
      },
    })
  })

  test("uses a larger trim batch for overflow preflight", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
          },
          limit: {
            context: 100_000,
            output: 1_000,
          },
        } as any)

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "run",
        })

        const prior = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "tool-calls",
        } as any)

        for (let i = 0; i < 10; i++) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: prior.id,
            type: "tool",
            callID: `call-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: "x".repeat(4_000),
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          } as any)
        }

        const calls = { count: 0 }
        spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage as MessageV2.Assistant

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            process: async () => {
              calls.count += 1
              if (calls.count === 1) {
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "text",
                  text: "y".repeat(360_000),
                })
                assistant.tokens = {
                  input: 100_200,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                }
                assistant.finish = "tool-calls"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "compact"
              }

              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "text",
                text: "done",
              })
              assistant.finish = "stop"
              assistant.time.completed = Date.now()
              await Session.updateMessage(assistant)
              return "stop"
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const marker = msgs
          .flatMap((msg) => msg.parts)
          .find((part) => {
            if (part.type !== "text") return false
            if (part.ignored !== true) return false
            const meta = part.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          }) as MessageV2.TextPart | undefined

        expect(marker).toBeDefined()

        const meta = (marker?.metadata as any)?.opencode?.marker
        expect(meta?.tokens).toBeGreaterThanOrEqual(3_000)
      },
    })
  })

  test("skips debt-only overflow trimming when estimate is already below target", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
          },
          limit: {
            context: 1_000_000,
            output: 1_000,
          },
        } as any)

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "run",
        })

        const prior = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "tool-calls",
        } as any)

        for (let i = 0; i < 10; i++) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: prior.id,
            type: "tool",
            callID: `call-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: "x".repeat(4_000),
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          } as any)
        }

        const calls = { count: 0 }
        spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage as MessageV2.Assistant

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            process: async () => {
              calls.count += 1
              if (calls.count === 1) {
                assistant.tokens = {
                  input: 100_200,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                }
                assistant.finish = "tool-calls"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "compact"
              }

              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "text",
                text: "done",
              })
              assistant.finish = "stop"
              assistant.time.completed = Date.now()
              await Session.updateMessage(assistant)
              return "stop"
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const marker = msgs
          .flatMap((msg) => msg.parts)
          .find((part) => {
            if (part.type !== "text") return false
            if (part.ignored !== true) return false
            const meta = part.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          })

        expect(marker).toBeUndefined()

        const compacted = msgs
          .flatMap((msg) => msg.parts)
          .filter((part) => {
            if (part.type !== "tool") return false
            if (part.state.status !== "completed") return false
            return typeof part.state.time.compacted === "number"
          })

        expect(compacted.length).toBe(0)
      },
    })
  })

  test("does not carry overflow debt across pending user chains", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
          },
          limit: {
            context: 40_000,
            output: 1_000,
          },
        } as any)

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()

        const seed = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: seed.id,
          type: "text",
          text: "seed",
        })

        const prior = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: seed.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "stop",
        } as any)

        for (let i = 0; i < 15; i++) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: prior.id,
            type: "tool",
            callID: `seed-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: "x".repeat(4_000),
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          } as any)
        }

        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user1.id,
          type: "text",
          text: "f".repeat(70_000),
        })

        const user2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          system: "different-system",
          time: { created: now + 3 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user2.id,
          type: "text",
          text: "z".repeat(26_000),
        })

        const calls = { user1: 0, user2: 0 }
        spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage as MessageV2.Assistant

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            process: async (args: any) => {
              if (args.user.id === user1.id) {
                calls.user1 += 1
                if (calls.user1 === 1) {
                  assistant.tokens = {
                    input: 200_000,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 },
                  }
                  assistant.finish = "tool-calls"
                  assistant.time.completed = Date.now()
                  await Session.updateMessage(assistant)
                  return "compact"
                }

                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "text",
                  text: "first done",
                })
                for (let i = 0; i < 10; i++) {
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    sessionID: session.id,
                    messageID: assistant.id,
                    type: "tool",
                    callID: `u1-${i}`,
                    tool: "bash",
                    state: {
                      status: "completed",
                      input: { command: `echo u1-${i}` },
                      output: "y".repeat(4_000),
                      title: "bash",
                      metadata: {},
                      time: { start: Date.now(), end: Date.now() },
                    },
                  } as any)
                }
                assistant.finish = "stop"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "continue"
              }

              if (args.user.id === user2.id) {
                calls.user2 += 1
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "text",
                  text: "second done",
                })
                assistant.finish = "stop"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "continue"
              }

              throw new Error("unexpected user")
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const reply = msgs.find((msg) => msg.info.role === "assistant" && (msg.info as any).parentID === user2.id)
        expect(reply).toBeDefined()

        const marker = reply!.parts.find((part) => {
          if (part.type !== "text") return false
          if (part.ignored !== true) return false
          const meta = part.metadata as any
          return meta?.opencode?.marker?.kind === "trim"
        })

        expect(marker).toBeDefined()
        const tokens = ((marker as any).metadata?.opencode?.marker?.tokens ?? 0) as number
        expect(tokens).toBeLessThan(20_000)
      },
    })
  })

  test("sizes overflow debt from estimator gap instead of provider usage totals", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
          },
          limit: {
            context: 120_000,
            output: 1_000,
          },
        } as any)

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: user.id,
          type: "text",
          text: "run",
        })

        const prior = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "tool-calls",
        } as any)

        for (let i = 0; i < 40; i++) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: prior.id,
            type: "tool",
            callID: `seed-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: "x".repeat(4_000),
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          } as any)
        }

        const calls = { count: 0 }
        spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage as MessageV2.Assistant

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            process: async () => {
              calls.count += 1
              if (calls.count === 1) {
                await Session.updatePart({
                  id: Identifier.ascending("part"),
                  sessionID: session.id,
                  messageID: assistant.id,
                  type: "text",
                  text: "q".repeat(280_000),
                })
                assistant.tokens = {
                  input: 500_000,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                }
                assistant.finish = "tool-calls"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "compact"
              }

              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "text",
                text: "done",
              })
              assistant.finish = "stop"
              assistant.time.completed = Date.now()
              await Session.updateMessage(assistant)
              return "stop"
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const marker = msgs
          .flatMap((msg) => msg.parts)
          .find((part) => {
            if (part.type !== "text") return false
            if (part.ignored !== true) return false
            const meta = part.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          }) as MessageV2.TextPart | undefined

        expect(marker).toBeDefined()
        const tokens = ((marker?.metadata as any)?.opencode?.marker?.tokens ?? 0) as number
        expect(tokens).toBeLessThan(20_000)
      },
    })
  })
})
