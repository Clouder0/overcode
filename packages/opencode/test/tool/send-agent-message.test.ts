import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SendAgentMessageTool } from "../../src/tool/send-agent-message"

const projectRoot = path.join(__dirname, "../..")

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
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
      },
    })
  })
})
