import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
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
