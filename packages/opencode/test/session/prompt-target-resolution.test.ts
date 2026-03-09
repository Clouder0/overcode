import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

test("prompt does not livelock when target user is not relevant", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const now = Date.now()
      const userID = Identifier.ascending("message")

      await Session.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-4",
        },
        time: { created: now },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: "seed",
      })

      const seedAssistantID = Identifier.ascending("message")
      await Session.updateMessage({
        id: seedAssistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        modelID: "gpt-4",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: {
          cwd: tmp.path,
          root: tmp.path,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        time: {
          created: now + 1,
          completed: now + 1,
        },
        finish: "stop",
      })

      const run = SessionPrompt.prompt({
        sessionID: session.id,
        parts: [],
      })

      const race = await Promise.race([
        run.then((value) => ({ status: "resolved" as const, value })),
        Bun.sleep(350).then(() => ({ status: "timeout" as const })),
      ])

      if (race.status === "timeout") {
        await Session.remove(session.id).catch(() => {})
        await run.catch(() => {})
      }

      expect(race.status).toBe("resolved")
      if (race.status !== "resolved") return

      expect(race.value.info.role).toBe("assistant")
      expect((race.value.info as MessageV2.Assistant).id).toBe(seedAssistantID)
    },
  })
})

test("prompt with empty parts on fresh session does not throw", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        parts: [],
      })

      expect(result.info.role).toBe("user")
      expect(result.info.sessionID).toBe(session.id)
    },
  })
})

test("prompt resolves target assistant even with backlog beyond 32 entries", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const now = Date.now()
      for (let i = 0; i < 33; i++) {
        const id = Identifier.ascending("message")
        await Session.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          agent: "build",
          model: {
            providerID: "dummy",
            modelID: "dummy",
          },
          variant: `seed-${i}`,
          time: { created: now + i },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: id,
          type: "text",
          text: `seed ${i}`,
        })
      }

      const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
        id: "dummy",
        providerID: "dummy",
        modelID: "dummy",
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
            const message = args.assistantMessage
            message.finish = "end_turn"
            message.time.completed = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: message.id,
              type: "text",
              text: "ok",
            })
            await Session.updateMessage(message)
            return "stop"
          },
        } as any
      })

      await using _restore = {
        [Symbol.asyncDispose]: async () => {
          modelSpy.mockRestore()
          processorSpy.mockRestore()
        },
      }

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        variant: "target",
        parts: [{ type: "text", text: "target" }],
      })

      const target = (await Session.messages({ sessionID: session.id })).findLast(
        (msg) => msg.info.role === "user" && (msg.info as MessageV2.User).variant === "target",
      )

      expect(target).toBeDefined()
      if (!target) return
      expect(result.info.role).toBe("assistant")
      expect((result.info as MessageV2.Assistant).parentID).toBe(target.info.id)
    },
  })
}, 20_000)

test("prompt target resolution prioritizes the requested user over parked backlog", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const now = Date.now()
      const oldUser = Identifier.ascending("message")
      await Session.updateMessage({
        id: oldUser,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: {
          providerID: "dummy",
          modelID: "dummy",
        },
        variant: "old",
        time: { created: now },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: oldUser,
        type: "text",
        text: "old",
      })

      const parked = Identifier.ascending("message")
      await Session.updateMessage({
        id: parked,
        sessionID: session.id,
        role: "assistant",
        parentID: oldUser,
        modelID: "dummy",
        providerID: "dummy",
        mode: "build",
        agent: "build",
        path: {
          cwd: tmp.path,
          root: tmp.path,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        time: {
          created: now + 1,
          completed: now + 1,
        },
        finish: "tool-calls",
      })

      const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
        id: "dummy",
        providerID: "dummy",
        modelID: "dummy",
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
            const message = args.assistantMessage
            const msgs = await Session.messages({ sessionID: session.id })
            const parent = msgs.find((msg) => msg.info.id === message.parentID)
            if (!parent || parent.info.role !== "user") {
              throw new Error("unexpected-non-user-selection")
            }
            if ((parent.info as MessageV2.User).variant !== "target") {
              throw new Error("unexpected-backlog-selection")
            }
            message.finish = "end_turn"
            message.time.completed = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: message.id,
              type: "text",
              text: "target reply",
            })
            await Session.updateMessage(message)
            return "stop"
          },
        } as any
      })

      await using _restore = {
        [Symbol.asyncDispose]: async () => {
          modelSpy.mockRestore()
          processorSpy.mockRestore()
        },
      }

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        variant: "target",
        parts: [{ type: "text", text: "target" }],
      })

      expect(result.info.role).toBe("assistant")
      const parent = (await Session.messages({ sessionID: session.id })).find(
        (msg) => msg.info.id === (result.info as MessageV2.Assistant).parentID,
      )
      expect(parent?.info.role).toBe("user")
      expect((parent?.info as MessageV2.User | undefined)?.variant).toBe("target")
    },
  })
}, 20_000)

test("prompt does not resolve with a parked wait assistant for the requested user", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const source = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          WaitPolicy.clear(session.id)
          WaitPolicy.clear(source.id)
          await Session.remove(source.id).catch(() => {})
          await Session.remove(session.id).catch(() => {})
        },
      }

      const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
        id: "dummy",
        providerID: "dummy",
        modelID: "dummy",
        api: {
          id: "dummy",
          url: "",
          npm: "@ai-sdk/openai-compatible",
        },
        limit: { context: 8192, output: 2048 },
      } as any)

      const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)

      let parkedResolve: (() => void) | undefined
      const parked = new Promise<void>((resolve) => {
        parkedResolve = resolve
      })

      let calls = 0
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
            calls += 1

            if (calls === 1) {
              const policy = WaitPolicy.register({
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                callID: "call_wait",
                sources: [source.id],
                timeout: 2_000,
                mode: "all",
                since: SessionMessage.nowSeq(session.id),
              })

              SessionStatus.set(session.id, {
                type: "waiting",
                sources: policy.sources,
                timeout: policy.timeout,
                mode: policy.mode,
                since: policy.since,
                time: policy.time,
              })

              args.assistantMessage.finish = "tool-calls"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              parkedResolve?.()
              return "continue"
            }

            args.assistantMessage.finish = "stop"
            args.assistantMessage.time.completed = Date.now()
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: session.id,
              messageID: args.assistantMessage.id,
              type: "text",
              text: "final reply",
            })
            await Session.updateMessage(args.assistantMessage)
            return "stop"
          },
        } as any
      })

      await using _restore = {
        [Symbol.asyncDispose]: async () => {
          processorSpy.mockRestore()
          summarySpy.mockRestore()
          modelSpy.mockRestore()
        },
      }

      const run = SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        parts: [{ type: "text", text: "start" }],
      })

      await parked

      const race = await Promise.race([
        run.then((value) => ({ status: "resolved" as const, value })),
        Bun.sleep(150).then(() => ({ status: "pending" as const })),
      ])

      expect(race.status).toBe("pending")

      await SessionMessage.deliver({
        from: source.id,
        to: session.id,
        text: "ready",
        awaitWake: true,
      })

      const result = await run

      expect(result.info.role).toBe("assistant")
      expect((result.info as MessageV2.Assistant).finish).toBe("stop")
      expect(result.parts.some((part) => part.type === "text" && part.text.includes("final reply"))).toBe(true)
    },
  })
}, 20_000)
