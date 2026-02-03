import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SendAgentMessageTool } from "../../src/tool/send-agent-message"
import { tmpdir } from "../fixture/fixture"

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: async () => {},
  ask: async (_req: unknown) => {},
}

test("send_agent_message delivers into recipient session directory", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = tmp.path
  const sub = path.join(root, "subdir")
  await fs.mkdir(sub, { recursive: true })

  await Instance.provide({
    directory: root,
    fn: async () => {
      const sender = await Session.create({})

      const receiver = await Instance.provide({
        directory: sub,
        fn: async () => {
          return Session.create({})
        },
      })

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(receiver.id).catch(() => {})
          await Session.remove(sender.id).catch(() => {})
        },
      }

      const tool = await SendAgentMessageTool.init()

      const result = await tool.execute(
        { to: receiver.id, text: "hello" },
        {
          ...ctxBase,
          sessionID: sender.id,
        },
      )

      expect(result.metadata.ok).toBe(true)

      const lastRoot = SessionMessage.lastSeq(receiver.id, sender.id)
      expect(lastRoot).toBe(0)

      const lastSub = await Instance.provide({
        directory: sub,
        fn: async () => {
          return SessionMessage.lastSeq(receiver.id, sender.id)
        },
      })

      expect(lastSub).toBeGreaterThan(0)

      const pending = await Instance.provide({
        directory: sub,
        fn: async () => {
          return SessionMessage.peekPending(receiver.id)
        },
      })

      expect(pending.some((m) => m.from === sender.id && m.to === receiver.id && m.text === "hello")).toBe(true)
    },
  })
})
