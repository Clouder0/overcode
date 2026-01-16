import { expect, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

function monoNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

test("WaitPolicy timeout wake is not dropped while SessionPrompt.loop is active", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})

        allow.add(session.id)

        const now = Date.now()

        const userMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userMessageID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: "test",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userMessageID,
          type: "text",
          text: "start",
        })

        const waitMessageID = Identifier.ascending("message")
        const callID = "call_wait"
        const timeout = 50

        await Session.updateMessage({
          id: waitMessageID,
          sessionID: session.id,
          role: "assistant",
          time: {
            created: now,
            completed: now,
          },
          parentID: userMessageID,
          modelID: "gpt-4",
          providerID: "openai",
          mode: "default",
          agent: "test",
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
          finish: "tool-calls",
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: waitMessageID,
          type: "tool",
          callID,
          tool: "wait_agent_message",
          state: {
            status: "completed",
            input: {
              sources: [source.id],
              timeout,
              mode: "all",
            },
            output: "Wait registered. End your turn now.",
            title: "Wait registered",
            metadata: {},
            time: {
              start: now,
              end: now,
            },
          },
        })

        const sentinelID = Identifier.ascending("message")
        await Session.updateMessage({
          id: sentinelID,
          sessionID: session.id,
          role: "assistant",
          time: {
            created: now,
            completed: now,
          },
          parentID: userMessageID,
          modelID: "gpt-4",
          providerID: "openai",
          mode: "default",
          agent: "test",
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
          finish: "stop",
        })

        const originalStream = MessageV2.stream
        let delayed = false

        try {
          ;(MessageV2 as any).stream = ((sessionID: string) => {
            const stream = originalStream(sessionID)
            if (sessionID !== session.id) return stream
            if (delayed) return stream
            delayed = true
            return (async function* () {
              await Bun.sleep(timeout + 25)
              for await (const item of stream) {
                yield item
              }
            })()
          }) as any

          WaitPolicy.register({
            sessionID: session.id,
            messageID: waitMessageID,
            callID,
            sources: [source.id],
            timeout,
            mode: "all",
            since: 0,
          })

          await SessionPrompt.loop(session.id)

          const start = monoNow()
          while (monoNow() - start < 2000) {
            if (WaitPolicy.isWaiting(session.id)) {
              await Bun.sleep(5)
              continue
            }

            const parts = await MessageV2.parts(waitMessageID)
            const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === callID)
            if (tool && tool.state.status !== "pending" && tool.state.metadata?.status === "timedOut") {
              break
            }

            await Bun.sleep(5)
          }

          expect(WaitPolicy.isWaiting(session.id)).toBe(false)

          const parts = await MessageV2.parts(waitMessageID)
          const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === callID)
          if (!tool || tool.state.status !== "completed") {
            expect(tool?.state.status).toBe("completed")
            return
          }
          expect(tool.state.metadata.status).toBe("timedOut")
        } finally {
          ;(MessageV2 as any).stream = originalStream
          WaitPolicy.clear(session.id)
          await Session.remove(source.id)
          await Session.remove(session.id)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})
