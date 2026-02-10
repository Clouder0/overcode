import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { SessionProcessor } from "../../src/session/processor"
import { SessionMessage } from "../../src/session/message-routing"
import { MessageV2 } from "../../src/session/message-v2"
import { NamedError } from "@opencode-ai/util/error"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

async function seedUser(input: {
  sessionID: string
  text: string
  created: number
  modelID?: string
  providerID?: string
  agent?: string
  system?: string
  tools?: Record<string, boolean>
  variant?: string
}) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    agent: input.agent ?? "build",
    model: {
      providerID: input.providerID ?? "dummy",
      modelID: input.modelID ?? "dummy",
    },
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    time: { created: input.created },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: user.id,
    type: "text",
    text: input.text,
  })

  return user
}

async function assistantReplies(input: { sessionID: string; parentIDs: string[] }) {
  const messages = await Session.messages({ sessionID: input.sessionID })
  return messages.filter((msg) => {
    if (msg.info.role !== "assistant") return false
    const parentID = (msg.info as MessageV2.Assistant).parentID
    return input.parentIDs.includes(parentID)
  })
}

function batchUsers(msg: MessageV2.WithParts) {
  for (const part of msg.parts) {
    if (part.type !== "text") continue
    if (part.synthetic !== true) continue
    if (part.ignored !== true) continue
    const metadata = part.metadata
    if (!metadata || typeof metadata !== "object") continue
    const opencode = (metadata as { opencode?: unknown }).opencode
    if (!opencode || typeof opencode !== "object") continue
    const batch = (opencode as { batch?: unknown }).batch
    if (!batch || typeof batch !== "object") continue
    const users = (batch as { users?: unknown }).users
    if (!Array.isArray(users)) continue
    const ids = users.filter((x): x is string => typeof x === "string")
    if (ids.length > 0) return ids
  }

  return [] as string[]
}

describe("session.prompt queued batch context", () => {
  test("coalesces queued messages with same settings into one assistant turn", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

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

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "continue" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const u1 = await seedUser({
          sessionID: session.id,
          text: "u1",
          created: now,
          system: "sys",
          tools: { bash: true },
        })
        const u2 = await seedUser({
          sessionID: session.id,
          text: "u2",
          created: now + 1,
          system: "sys",
          tools: { bash: true },
        })

        await SessionPrompt.loop(session.id)

        const replies = await assistantReplies({ sessionID: session.id, parentIDs: [u1.id, u2.id] })
        expect(replies.length).toBe(1)
        expect((replies[0]?.info as MessageV2.Assistant).parentID).toBe(u1.id)
        expect(batchUsers(replies[0]!)).toEqual([u1.id, u2.id])
      },
    })
  })

  test("does not write batch coverage metadata when terminal assistant has error", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

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

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              args.assistantMessage.finish = "error"
              args.assistantMessage.error = new NamedError.Unknown({ message: "failed" }).toObject()
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const u1 = await seedUser({
          sessionID: session.id,
          text: "u1",
          created: now,
          system: "sys",
          tools: { bash: true },
        })
        const u2 = await seedUser({
          sessionID: session.id,
          text: "u2",
          created: now + 1,
          system: "sys",
          tools: { bash: true },
        })

        await SessionPrompt.loop(session.id)

        const replies = await assistantReplies({ sessionID: session.id, parentIDs: [u1.id, u2.id] })
        expect(replies.length).toBe(1)
        expect((replies[0]?.info as MessageV2.Assistant).parentID).toBe(u1.id)
        expect(batchUsers(replies[0]!)).toEqual([])
      },
    })
  })

  test("does not write batch coverage metadata when finish is error without payload", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

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

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              args.assistantMessage.finish = "error"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const u1 = await seedUser({
          sessionID: session.id,
          text: "u1",
          created: now,
          system: "sys",
          tools: { bash: true },
        })
        const u2 = await seedUser({
          sessionID: session.id,
          text: "u2",
          created: now + 1,
          system: "sys",
          tools: { bash: true },
        })

        await SessionPrompt.loop(session.id)

        const replies = await assistantReplies({ sessionID: session.id, parentIDs: [u1.id, u2.id] })
        expect(replies.length).toBe(1)
        expect((replies[0]?.info as MessageV2.Assistant).parentID).toBe(u1.id)
        expect(batchUsers(replies[0]!)).toEqual([])
      },
    })
  })

  test("splits batch when queued message settings differ", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        const providerSpy = spyOn(Provider, "getModel").mockImplementation(
          async (providerID: string, modelID: string) => {
            return {
              id: modelID,
              providerID,
              api: {
                id: modelID,
                url: "",
                npm: "@ai-sdk/openai-compatible",
              },
              limit: { context: 8192, output: 2048 },
            } as any
          },
        )

        const parents: string[] = []
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              parents.push(args.assistantMessage.parentID)
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "continue" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const u1 = await seedUser({ sessionID: session.id, text: "u1", created: now, modelID: "model-a" })
        const u2 = await seedUser({ sessionID: session.id, text: "u2", created: now + 1, modelID: "model-b" })

        await SessionPrompt.loop(session.id)

        expect(parents).toEqual([u1.id, u2.id])
      },
    })
  })

  test("incoming agent message queued before loop runs as a separate turn", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

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

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "continue" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(source.id)
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const u1 = await seedUser({ sessionID: session.id, text: "u1", created: now })
        const inbound = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "agent update",
        })

        await SessionPrompt.loop(session.id)

        const replies = await assistantReplies({ sessionID: session.id, parentIDs: [u1.id, inbound.id] })
        expect(replies.length).toBe(2)

        const humanReply = replies.find((reply) => (reply.info as MessageV2.Assistant).parentID === u1.id)
        const inboxReply = replies.find((reply) => (reply.info as MessageV2.Assistant).parentID === inbound.id)

        expect(humanReply).toBeDefined()
        expect(inboxReply).toBeDefined()
        expect(batchUsers(humanReply!)).toEqual([])
        expect(batchUsers(inboxReply!)).toEqual([])
      },
    })
  })
})
