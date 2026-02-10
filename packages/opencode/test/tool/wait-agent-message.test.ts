import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { SendAgentMessageTool } from "../../src/tool/send-agent-message"
import { WaitAgentMessageTool } from "../../src/tool/wait-agent-message"

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
              since: -1,
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
              since: -1,
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
              since: -1,
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
              since: -1,
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
              since: -1,
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
              since: -1,
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

  test("resolves immediately when source already responded after since", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const before = SessionMessage.checkpoint(session.id)
        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "already responded",
        })

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id],
            timeout: 1000,
            mode: "all",
            since: before,
          },
          {
            ...ctxBase,
            sessionID: session.id,
            extra: {
              waitContext: {
                maxSeqBySource: {
                  [source.id]: delivered.seq,
                },
              },
            },
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("resolved")
        expect(result.metadata.respondedSources).toEqual([source.id])

        const policy = WaitPolicy.get(session.id)
        expect(policy).toBeUndefined()

        const status = SessionStatus.get(session.id)
        expect(status.type).toBe("idle")
      },
    })
  })

  test("registers waiting when reply exists but is not in current model context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const since = SessionMessage.checkpoint(session.id)
        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "arrived after context snapshot",
        })

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id],
            timeout: 1000,
            mode: "all",
            since,
          },
          {
            ...ctxBase,
            sessionID: session.id,
            extra: {
              waitContext: {
                maxSeqBySource: {
                  [source.id]: since,
                },
              },
            },
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("waiting")

        const policy = WaitPolicy.get(session.id)
        expect(policy).toBeDefined()
        expect(policy?.sources).toEqual([source.id])
        expect(policy?.since).toBe(since)

        const status = SessionStatus.get(session.id)
        expect(status.type).toBe("waiting")
      },
    })
  })

  test("wildcard immediate-resolve ignores non-session senders", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        created.push(session.id)

        const since = SessionMessage.checkpoint(session.id)
        await SessionMessage.deliver({
          from: "human",
          to: session.id,
          text: "human interrupt",
        })

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: ["*"],
            timeout: 1000,
            mode: "any",
            since,
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("waiting")
      },
    })
  })

  test("blocks wildcard since=-1 right after explicit same-turn send", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const waiter = await Session.create({})
        const target = await Session.create({})
        created.push(waiter.id, target.id)

        const sendTool = await SendAgentMessageTool.init()
        const msgID = "msg_same_turn"

        const sent = await sendTool.execute(
          {
            to: target.id,
            text: "please report back",
          },
          {
            ...ctxBase,
            messageID: msgID,
            callID: "call_send",
            sessionID: waiter.id,
          },
        )

        expect(sent.metadata.ok).toBe(true)

        const waitTool = await WaitAgentMessageTool.init()
        const result = await waitTool.execute(
          {
            sources: ["*"],
            timeout: 1000,
            mode: "any",
            since: -1,
          },
          {
            ...ctxBase,
            messageID: msgID,
            callID: "call_wait",
            sessionID: waiter.id,
          },
        )

        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.status).toBe("blocked")
        expect(result.metadata.error).toContain("sources=[\"*\"]")
      },
    })
  })

  test("clamps stale future since cursor to current seq", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const now = SessionMessage.nowSeq(session.id)
        const since = now + 100

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id],
            timeout: 1000,
            mode: "all",
            since,
          },
          {
            ...ctxBase,
            sessionID: session.id,
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("waiting")
        expect(result.metadata.since).toBe(SessionMessage.nowSeq(session.id))
        expect(result.metadata.warning).toContain("clamped")
      },
    })
  })

  test("blocks when since=0 is used", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const tool = await WaitAgentMessageTool.init()
        let threw = false
        try {
          await tool.execute(
            {
              sources: [source.id],
              timeout: 1000,
              mode: "all",
              since: 0,
            },
            {
              ...ctxBase,
              sessionID: session.id,
            },
          )
        } catch (error) {
          threw = true
          const msg = error instanceof Error ? error.message : String(error)
          expect(msg).toContain("since must be -1 or a positive seq checkpoint")
        }

        expect(threw).toBe(true)
      },
    })
  })

  test("warns when since=-1 already matches history", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        created.push(session.id, source.id)

        const delivered = await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "already here",
        })

        const tool = await WaitAgentMessageTool.init()
        const result = await tool.execute(
          {
            sources: [source.id],
            timeout: 1000,
            mode: "any",
            since: -1,
          },
          {
            ...ctxBase,
            sessionID: session.id,
            extra: {
              waitContext: {
                maxSeqBySource: {
                  [source.id]: delivered.seq,
                },
              },
            },
          },
        )

        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe("resolved")
        expect(result.metadata.mode).toBe("all")
        expect(result.metadata.warning).toContain("since=-1 matched prior messages")
        expect(result.output).toContain("Warning:")

        const policy = WaitPolicy.get(session.id)
        expect(policy).toBeUndefined()
        expect(SessionStatus.get(session.id).type).toBe("idle")
      },
    })
  })
})
