import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

test("prompt avoids redundant hydrated history reloads within a single turn", async () => {
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

      const seed = Identifier.ascending("message")
      await Session.updateMessage({
        id: seed,
        sessionID: session.id,
        role: "user",
        agent: "build",
        model: {
          providerID: "dummy",
          modelID: "dummy",
        },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: seed,
        type: "text",
        text: "seed",
      })

      const historySpy = spyOn(Session, "messages")
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
            const message = args.assistantMessage as MessageV2.Assistant
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
          historySpy.mockRestore()
          modelSpy.mockRestore()
          processorSpy.mockRestore()
        },
      }

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        parts: [{ type: "text", text: "target" }],
      })

      expect(result.info.role).toBe("assistant")
      expect(historySpy).toHaveBeenCalledTimes(4)
    },
  })
}, 20_000)
