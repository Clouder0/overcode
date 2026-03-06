import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageParser } from "../../src/session/message-parser"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("non-terminal send turn consumes inbound inbox message once", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        const sink = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(sink.id)
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const calls = { count: 0 }
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process(input: any) {
              calls.count += 1

              const tools = (input?.tools ?? {}) as Record<
                string,
                { execute: (params: any, options: any) => Promise<any> }
              >

              if (calls.count === 1) {
                await tools.send_agent_message.execute(
                  {
                    to: sink.id,
                    text: "ack",
                  },
                  {
                    toolCallId: "call_send_1",
                  },
                )

                args.assistantMessage.finish = "tool-calls"
                args.assistantMessage.time.completed = Date.now()
                await Session.updateMessage(args.assistantMessage)
                return "continue"
              }

              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "status update",
        })

        await SessionPrompt.loop(session.id)

        expect(calls.count).toBe(1)

        const message = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const inbound = message.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          return part.direction === "incoming"
        })

        expect(inbound).toBeDefined()

        const meta = inbound?.metadata as
          | {
              opencode?: {
                consumed?: boolean
              }
            }
          | undefined

        expect(meta?.opencode?.consumed).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})

test("consumed inbound inbox message stays visible in later context", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "status update",
        })

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const seen = {
          calls: 0,
          user: "",
          hasInbound: false,
        }

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process(input: any) {
              seen.calls += 1

              if (seen.calls === 2) {
                seen.user = input.user.id
                seen.hasInbound = JSON.stringify(input.messages ?? []).includes("status update")
              }

              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        await SessionPrompt.loop(session.id)

        const message = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const inbound = message.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          return part.direction === "incoming"
        })

        expect(inbound).toBeDefined()
        expect((inbound?.metadata as any)?.opencode?.consumed).toBe(true)

        const now = Date.now()
        const humanID = Identifier.ascending("message")
        await Session.updateMessage({
          id: humanID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: humanID,
          type: "text",
          text: "human task",
        })

        await SessionPrompt.loop(session.id)

        expect(seen.calls).toBe(2)
        expect(seen.user).toBe(humanID)
        expect(seen.hasInbound).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})

test("consumed inbound wait_result message stays visible in later context", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: MessageParser.formatWaitResult({
            status: "resolved",
            timeoutMs: 30000,
            mode: "all",
            since: 1,
            sources: [source.id],
            responded: [source.id],
            timedOut: [],
          }),
          messageType: "wait_result",
        })

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const seen = {
          calls: 0,
          user: "",
          hasInbound: false,
        }

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process(input: any) {
              seen.calls += 1

              if (seen.calls === 2) {
                seen.user = input.user.id
                seen.hasInbound = JSON.stringify(input.messages ?? []).includes("Wait resolved")
              }

              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        await SessionPrompt.loop(session.id)

        const message = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const inbound = message.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          if (part.direction !== "incoming") return false
          return part.peerType === "system"
        })

        expect(inbound).toBeDefined()
        expect((inbound?.metadata as any)?.opencode?.consumed).toBe(true)
        expect((inbound?.metadata as any)?.opencode?.messageType).toBe("wait_result")
        expect((inbound?.metadata as any)?.opencode?.waitStatus).toBe("resolved")

        const now = Date.now()
        const humanID = Identifier.ascending("message")
        await Session.updateMessage({
          id: humanID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: humanID,
          type: "text",
          text: "human task",
        })

        await SessionPrompt.loop(session.id)

        expect(seen.calls).toBe(2)
        expect(seen.user).toBe(humanID)
        expect(seen.hasInbound).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})

test("human-anchored turn does not consume inbound message until inbox turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const seedID = Identifier.ascending("message")
        await Session.updateMessage({
          id: seedID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: seedID,
          type: "text",
          text: "human task",
        })

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "agent update",
        })

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const calls = { count: 0 }
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process() {
              calls.count += 1
              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        await SessionPrompt.loop(session.id)

        const first = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const firstInbound = first.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          return part.direction === "incoming"
        })

        expect(firstInbound).toBeDefined()
        expect((firstInbound?.metadata as any)?.opencode?.consumed).not.toBe(true)

        await SessionPrompt.loop(session.id)

        const second = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const secondInbound = second.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          return part.direction === "incoming"
        })

        expect((secondInbound?.metadata as any)?.opencode?.consumed).toBe(true)
        expect(calls.count).toBe(2)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})

test("incoming inbox preempts parked nonterminal task turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        const now = Date.now()
        const seedID = Identifier.ascending("message")
        await Session.updateMessage({
          id: seedID,
          sessionID: session.id,
          role: "user",
          time: { created: now - 1000 },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: seedID,
          type: "text",
          text: "seed",
        })

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "assistant",
          parentID: seedID,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          providerID: "dummy",
          modelID: "dummy",
          time: { created: now - 900, completed: now - 900 },
          finish: "tool-calls",
        } satisfies MessageV2.Assistant)

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "agent update",
        })

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const seen = {
          calls: 0,
          anchor: "",
          hasIncoming: false,
        }

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process(input: any) {
              seen.calls += 1
              seen.anchor = input.user.id
              seen.hasIncoming = JSON.stringify(input.messages ?? []).includes("agent update")
              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        await SessionPrompt.loop(session.id)

        expect(seen.calls).toBe(1)
        expect(seen.anchor).toBe(delivered.id)
        expect(seen.hasIncoming).toBe(true)

        const message = await MessageV2.get({
          sessionID: session.id,
          messageID: delivered.id,
        })

        const inbound = message.parts.find((part): part is MessageV2.MessagePart => {
          if (part.type !== "message") return false
          return part.direction === "incoming"
        })

        expect((inbound?.metadata as any)?.opencode?.consumed).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})
