import { expect, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

type SeededWait = {
  sessionID: string
  sourceID: string
  waitMessageID: string
  callID: string
}

async function seedWait(root: string): Promise<SeededWait> {
  const session = await Session.create({})
  const source = await Session.create({})

  const now = Date.now()
  const timeout = 10_000

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
  const callID = "call_wait"

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
      },
      output: "Wait registered. End your turn now.",
      title: "Wait registered",
      metadata: {
        ok: true,
        status: "waiting",
        sources: [source.id],
        respondedSources: [],
        timedOutSources: [],
        timeout,
        mode: "all",
        allReceived: false,
      },
      time: {
        start: now,
        end: now,
      },
    },
  })

  const policy = WaitPolicy.register({
    sessionID: session.id,
    messageID: waitMessageID,
    callID,
    sources: [source.id],
    timeout,
    mode: "all",
    since: 0,
  })

  SessionStatus.set(session.id, {
    type: "waiting",
    sources: [source.id],
    timeout,
    mode: "all",
    time: policy.time,
  })

  return {
    sessionID: session.id,
    sourceID: source.id,
    waitMessageID,
    callID,
  }
}

test("human prompt interrupts active wait_agent_message", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const seeded = await seedWait(tmp.path)

      try {
        await SessionPrompt.prompt({
          sessionID: seeded.sessionID,
          noReply: true,
          parts: [
            {
              type: "text",
              text: "hello",
            },
          ],
        })

        expect(WaitPolicy.isWaiting(seeded.sessionID)).toBe(false)

        const parts = await MessageV2.parts(seeded.waitMessageID)
        const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
        expect(tool).toBeDefined()

        const meta = (tool!.state as any).metadata as any
        expect(meta?.status).toBe("interrupted")
        expect(meta?.interruptedBy).toBe("prompt")
        expect(typeof meta?.interruptedAt).toBe("number")
        expect(meta?.interruptedAt).toBeGreaterThanOrEqual(meta?.createdAt ?? 0)
      } finally {
        WaitPolicy.clear(seeded.sessionID)
        WaitPolicy.clear(seeded.sourceID)
        await Session.remove(seeded.sourceID)
        await Session.remove(seeded.sessionID)
      }
    },
  })
})

test("human abort interrupts active wait_agent_message", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const seeded = await seedWait(tmp.path)

      try {
        SessionPrompt.cancel(seeded.sessionID)

        expect(WaitPolicy.isWaiting(seeded.sessionID)).toBe(false)

        let meta: any
        for (let i = 0; i < 100; i++) {
          const parts = await MessageV2.parts(seeded.waitMessageID)
          const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
          meta = (tool?.state as any)?.metadata
          if (meta?.status === "interrupted") break
          await Bun.sleep(10)
        }

        expect(meta?.status).toBe("interrupted")
        expect(meta?.interruptedBy).toBe("abort")
        expect(typeof meta?.interruptedAt).toBe("number")
        expect(meta?.interruptedAt).toBeGreaterThanOrEqual(meta?.createdAt ?? 0)
      } finally {
        WaitPolicy.clear(seeded.sessionID)
        WaitPolicy.clear(seeded.sourceID)
        await Session.remove(seeded.sourceID)
        await Session.remove(seeded.sessionID)
      }
    },
  })
})
