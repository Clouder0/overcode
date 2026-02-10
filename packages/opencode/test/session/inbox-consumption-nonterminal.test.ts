import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
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
