import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("idle burst of inbound agent messages triggers one loop + one model turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          title: "inbox burst",
        })
        const source = await Session.create({})
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
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
            async process() {
              calls.count += 1
              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "update 1",
          awaitWake: true,
        })

        await Bun.sleep(30)

        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "update 2",
          awaitWake: true,
        })

        await Bun.sleep(600)

        expect(calls.count).toBe(1)

        const history = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        const assistants = history.filter((msg) => msg.info.role === "assistant")
        expect(assistants.length).toBe(1)

        processorSpy.mockRestore()
        providerSpy.mockRestore()
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

test("inbox settle absorbs late inbound messages into the same model turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          title: "inbox settle",
        })
        const source = await Session.create({})
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
          },
        }

        const gate = Promise.withResolvers<void>()
        const dummy = {
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any

        const providerSpy = spyOn(Provider, "getModel").mockImplementation(async () => {
          gate.resolve()
          await Bun.sleep(150)
          return dummy
        })

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

        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "update 1",
          awaitWake: true,
        })

        await gate.promise

        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "update 2",
          awaitWake: true,
        })

        await Bun.sleep(900)

        expect(calls.count).toBe(1)

        processorSpy.mockRestore()
        providerSpy.mockRestore()
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

test("busy session batches inbound agent burst into a single follow-up turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          title: "busy burst",
        })
        const source = await Session.create({})
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
          },
        }

        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "dummy",
            modelID: "dummy",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text: "seed",
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

        const first = Promise.withResolvers<void>()
        const second = Promise.withResolvers<void>()

        const calls = { count: 0 }
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process() {
              calls.count += 1
              if (calls.count === 1) {
                first.resolve()
                await Bun.sleep(200)
              }

              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)

              if (calls.count === 2) {
                second.resolve()
              }

              return "stop"
            },
          } as any
        })

        const run = SessionPrompt.loop(session.id)

        await first.promise

        const burst = await Promise.all([
          SessionMessage.deliver({
            from: source.id,
            to: session.id,
            text: "update 1",
            awaitWake: true,
          }),
          SessionMessage.deliver({
            from: source.id,
            to: session.id,
            text: "update 2",
            awaitWake: true,
          }),
          SessionMessage.deliver({
            from: source.id,
            to: session.id,
            text: "update 3",
            awaitWake: true,
          }),
        ])

        await run
        await second.promise

        expect(calls.count).toBe(2)

        const history = await MessageV2.filterCompacted(MessageV2.stream(session.id))
        const inbox = burst.map((msg) => msg.id)
        const follow = history
          .filter((msg) => msg.info.role === "assistant")
          .findLast((msg) => msg.parts.some((p) => p.type === "text" && (p as any)?.metadata?.opencode?.batch))

        expect(follow).toBeDefined()

        const batch = follow?.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => (p as any)?.metadata?.opencode?.batch)
          .find((b: any) => b && typeof b === "object" && Array.isArray(b.users))

        expect(batch).toBeDefined()
        expect(inbox.every((id) => batch.users.includes(id))).toBe(true)

        processorSpy.mockRestore()
        providerSpy.mockRestore()
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
