import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"

Log.init({ print: false })

test("prompt noReply returns user info with persisted order", async () => {
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

      const agents = await Agent.list()
      const primary = agents.find((a) => a.mode !== "subagent" && !a.hidden)
      if (!primary) {
        throw new Error("no primary agent available")
      }

      const msg = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: primary.name,
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "hello" }],
        noReply: true,
      })

      expect(msg.info.role).toBe("user")
      if (msg.info.role !== "user") {
        throw new Error("expected user message")
      }

      const order = msg.info.order
      expect(typeof order).toBe("number")
      expect(Number.isInteger(order)).toBe(true)
      expect(order).toBeGreaterThan(0)
    },
  })
})
