import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { WaitAgentMessageTool } from "../../src/tool/wait-agent-message"

const projectRoot = path.join(__dirname, "../..")

const ctxBase = {
  messageID: "msg_test",
  callID: "call_test",
  agent: "test",
  abort: AbortSignal.any([]),
  metadata: () => {},
}

describe("tool.wait_agent_message validation", () => {
  const created: string[] = []

  afterEach(async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const id of created) {
          WaitPolicy.clear(id)
          SessionStatus.set(id, { type: "idle" })
          await Session.remove(id)
        }
        created.length = 0
      },
    })
  })

  test("blocks on empty sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [],
            timeout: 1000,
            mode: "all",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.status).toBe("blocked")
      },
    })
  })

  test("schema rejects timeout <= 0", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const tool = await WaitAgentMessageTool.init()

        // Schema validation should reject timeout=0
        let threw = false
        try {
          await tool.execute(
            {
              sources: [source.id],
              timeout: 0,
              mode: "all",
            },
            {
              ...ctxBase,
              sessionID: session.id,
            },
          )
        } catch {
          threw = true
        }
        expect(threw).toBe(true)
      },
    })
  })

  test("blocks on invalid session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: ["not_a_session_id"],
            timeout: 1000,
            mode: "all",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.status).toBe("blocked")
      },
    })
  })

  test("blocks on unknown session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: ["ses_missing"],
            timeout: 1000,
            mode: "all",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.status).toBe("blocked")
      },
    })
  })

  test("blocks on duplicate sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id, source.id],
            timeout: 1000,
            mode: "all",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.status).toBe("blocked")
      },
    })
  })

  test("registers wait for valid sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id],
            timeout: 1000,
            mode: "all",
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("waiting")

        const policy = WaitPolicy.get(session.id)
        expect(policy?.sources).toEqual([source.id])

        const status = SessionStatus.get(session.id)
        expect(status.type).toBe("waiting")
      },
    })
  })
})
