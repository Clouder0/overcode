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
      expect(typeof result.metadata.seq).toBe("number")
      expect((result.metadata as { deliverySeq?: number }).deliverySeq).toBeUndefined()

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

test("send_agent_message returns a seq checkpoint usable as since across directories", async () => {
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

      await Instance.provide({
        directory: sub,
        fn: async () => {
          const a = await Session.create({})
          const b = await Session.create({})
          for (let i = 0; i < 5; i++) {
            await SessionMessage.deliver({
              from: a.id,
              to: b.id,
              text: `warmup-${i}`,
            })
          }
          await Session.remove(a.id).catch(() => {})
          await Session.remove(b.id).catch(() => {})
        },
      })

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(receiver.id).catch(() => {})
          await Session.remove(sender.id).catch(() => {})
        },
      }

      const tool = await SendAgentMessageTool.init()

      const sent = await tool.execute(
        { to: receiver.id, text: "hello" },
        {
          ...ctxBase,
          sessionID: sender.id,
          messageID: "msg_send",
          callID: "call_send",
        },
      )

      const meta = sent.metadata as { seq?: number; since?: number }
      expect(typeof meta.seq).toBe("number")
      expect(meta.since).toBeUndefined()

      await tool.execute(
        { to: sender.id, text: "reply" },
        {
          ...ctxBase,
          sessionID: receiver.id,
          messageID: "msg_reply",
          callID: "call_reply",
        },
      )

      const responded = SessionMessage.responded({
        to: sender.id,
        sources: [receiver.id],
        since: meta.seq ?? -1,
      })

      expect(responded.has(receiver.id)).toBe(true)
    },
  })
})

test("cross-directory consecutive sends return unique checkpoints", async () => {
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

      const first = await tool.execute(
        { to: receiver.id, text: "one" },
        {
          ...ctxBase,
          sessionID: sender.id,
          messageID: "msg_one",
          callID: "call_one",
        },
      )

      const second = await tool.execute(
        { to: receiver.id, text: "two" },
        {
          ...ctxBase,
          sessionID: sender.id,
          messageID: "msg_two",
          callID: "call_two",
        },
      )

      expect(first.metadata.ok).toBe(true)
      expect(second.metadata.ok).toBe(true)
      expect((second.metadata.seq ?? 0) > (first.metadata.seq ?? 0)).toBe(true)
    },
  })
})
