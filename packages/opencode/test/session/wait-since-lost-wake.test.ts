import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

function monoNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

type Seeded = {
  sessionID: string
  sourceID: string
  waitMessageID: string
  callID: string
}

async function seed(root: string): Promise<Seeded> {
  const session = await Session.create({})
  const source = await Session.create({})

  const now = Date.now()
  const timeout = 250
  const callID = "call_wait"

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
    text: "seed",
  })

  const waitMessageID = Identifier.ascending("message")
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
      cwd: root,
      root,
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
        since: 0,
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
      cwd: root,
      root,
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

  return {
    sessionID: session.id,
    sourceID: source.id,
    waitMessageID,
    callID,
  }
}

test("wait resolves even if message arrived and pending was drained before wait registration", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        try {
          const since = SessionMessage.nowSeq()

          await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "early reply",
          })

          // Simulate the core failure mode: message got drained from pending before wait is registered.
          SessionMessage.takePending(seeded.sessionID, () => true)

          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 250,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 250,
            mode: "all",
            time: policy.time,
          })

          await SessionPrompt.loop(seeded.sessionID)

          const start = monoNow()
          while (monoNow() - start < 2000) {
            if (WaitPolicy.isWaiting(seeded.sessionID)) {
              await Bun.sleep(5)
              continue
            }

            const parts = await MessageV2.parts(seeded.waitMessageID)
            const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
            if (tool?.type !== "tool") {
              await Bun.sleep(5)
              continue
            }

            const meta = tool.state.status === "completed" ? tool.state.metadata : undefined
            if (meta && meta.status === "resolved") {
              expect(meta.respondedSources).toEqual([seeded.sourceID])
              return
            }

            await Bun.sleep(5)
          }

          expect(WaitPolicy.isWaiting(seeded.sessionID)).toBe(false)
          const parts = await MessageV2.parts(seeded.waitMessageID)
          const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
          expect(tool?.type).toBe("tool")
          if (tool?.type !== "tool") return
          expect(tool.state.status).toBe("completed")
          if (tool.state.status !== "completed") return
          expect(tool.state.metadata.status).toBe("resolved")
          expect(tool.state.metadata.respondedSources).toEqual([seeded.sourceID])
        } finally {
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
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
