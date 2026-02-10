import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SendAgentMessageTool } from "../../src/tool/send-agent-message"

const projectRoot = path.join(__dirname, "../..")

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async (_req: unknown) => {},
}

describe("tool.send_agent_message validation", () => {
  const created: string[] = []

  afterEach(async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const id of created) {
          await Session.remove(id)
        }
        created.length = 0
      },
    })
  })

  test("blocks on invalid session id format", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const tool = await SendAgentMessageTool.init()
        const result = await tool.execute(
          {
            to: "not_a_valid_session_id",
            text: "Hello",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.error).toContain("Invalid session id")
      },
    })
  })

  test("blocks on unknown session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const tool = await SendAgentMessageTool.init()
        const result = await tool.execute(
          {
            to: "ses_unknown_12345",
            text: "Hello",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.error).toContain("Unknown session id")
      },
    })
  })

  test("succeeds with valid session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        const tool = await SendAgentMessageTool.init()
        const result = await tool.execute(
          {
            to: receiver.id,
            text: "Hello from sender",
          },
          {
            ...ctxBase,
            sessionID: sender.id,
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.target).toBe(receiver.id)
        expect(typeof result.metadata.seq).toBe("number")
        expect((result.metadata.seq ?? 0) > 0).toBe(true)
        expect((result.metadata as { since?: number }).since).toBeUndefined()
        expect((result.metadata as { deliverySeq?: number }).deliverySeq).toBeUndefined()
        expect(result.output).toContain("checkpoint seq")
        expect(result.output).toContain("Checkpoint seq is your sender-side wait cursor")
        expect(result.output).toContain("Incoming replies may not appear in the current model-context snapshot immediately")
        expect(result.output).not.toContain("display order")
        expect(result.output).toContain("Use since=")
        expect(result.output).toContain("Sending does not require immediate waiting")
        expect(result.output).toContain("Before ending your turn, if this reply is still required")
        expect(result.output).toContain("continue or end your turn without waiting")
        expect(result.output).not.toContain("Reminder: wait_agent_message")
        expect(result.output).not.toContain("Delivery seq")
      },
    })
  })

  test("returns blocked when recipient wake/persist path fails", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        const prev = SessionMessage.setWakeSessionFn(async () => {
          throw new Error("persist failed")
        })

        try {
          const tool = await SendAgentMessageTool.init()
          const result = await tool.execute(
            {
              to: receiver.id,
              text: "Hello from sender",
            },
            {
              ...ctxBase,
              sessionID: sender.id,
            },
          )

          expect(result.metadata.ok).toBe(false)
          expect(result.metadata.error).toContain("persist failed")
        } finally {
          SessionMessage.setWakeSessionFn(prev)
        }
      },
    })
  })

  test("returns unique checkpoint seq for consecutive sends", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sender = await Session.create({})
        const receiver = await Session.create({})
        created.push(sender.id, receiver.id)

        const tool = await SendAgentMessageTool.init()
        const first = await tool.execute(
          {
            to: receiver.id,
            text: "first",
          },
          {
            ...ctxBase,
            sessionID: sender.id,
            callID: "call_first",
          },
        )

        const second = await tool.execute(
          {
            to: receiver.id,
            text: "second",
          },
          {
            ...ctxBase,
            sessionID: sender.id,
            callID: "call_second",
          },
        )

        expect(first.metadata.ok).toBe(true)
        expect(second.metadata.ok).toBe(true)
        expect((second.metadata.seq ?? 0) > (first.metadata.seq ?? 0)).toBe(true)
      },
    })
  })
})
