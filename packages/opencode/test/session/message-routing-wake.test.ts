import { beforeEach, expect, test } from "bun:test"
import "../../src/session/prompt"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { SessionMessage } from "../../src/session/message-routing"
import { Session } from "../../src/session"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"

const projectRoot = path.join(__dirname, "../..")

const withinInstance = <T>(fn: () => T | Promise<T>) =>
  Instance.provide({
    directory: projectRoot,
    fn,
  })

test("persists delivered message with deterministic MessagePart id", async () => {
  await withinInstance(async () => {
    const sessionID = Identifier.ascending("session")

    const seedID = Identifier.ascending("message")
    await Session.updateMessage({
      id: seedID,
      sessionID,
      role: "user",
      agent: "build",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
      },
      time: { created: Date.now() },
    })
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: seedID,
      sessionID,
      type: "text",
      text: "seed",
    })

    const delivered = await SessionMessage.deliver({
      from: Identifier.ascending("session"),
      to: sessionID,
      text: "hello",
    })

    let stored: unknown
    for (let i = 0; i < 100; i++) {
      stored = await Storage.read(["message", sessionID, delivered.id]).catch(() => undefined)
      if (stored) break
      await Bun.sleep(10)
    }

    expect(stored).toBeDefined()

    let msg: MessageV2.MessagePart | undefined
    for (let i = 0; i < 100; i++) {
      const parts = await MessageV2.parts(delivered.id)
      msg = parts.find((p): p is MessageV2.MessagePart => p.type === "message")
      if (msg) break
      await Bun.sleep(10)
    }

    expect(msg).toBeDefined()
    expect(msg?.id).toBe(delivered.id.replace(/^msg_/, "prt_"))
  })
})

describeWaitDrain()

function describeWaitDrain() {
  const sessionID = Identifier.ascending("session")
  const sources = [Identifier.ascending("session"), Identifier.ascending("session")]

  beforeEach(async () => {
    await withinInstance(() => {
      WaitPolicy.clear(sessionID)
      SessionMessage.clear(sessionID)
      SessionStatus.set(sessionID, { type: "idle" })
    })
  })

  test("waiting drains non-source pending messages after persisting", async () => {
    await withinInstance(async () => {
      const seedID = Identifier.ascending("message")
      await Session.updateMessage({
        id: seedID,
        sessionID,
        role: "user",
        agent: "build",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-20250514",
        },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: seedID,
        sessionID,
        type: "text",
        text: "seed",
      })

      const policy = WaitPolicy.register({
        sessionID,
        messageID: Identifier.ascending("message"),
        callID: "call",
        sources,
        timeout: 10_000,
        mode: "all",
      })

      SessionStatus.set(sessionID, {
        type: "waiting",
        sources,
        timeout: 10_000,
        mode: "all",
        time: policy.time,
      })

      const other = Identifier.ascending("session")
      const delivered = await SessionMessage.deliver({
        from: other,
        to: sessionID,
        text: "non-source",
      })

      let stored: unknown
      for (let i = 0; i < 100; i++) {
        stored = await Storage.read(["message", sessionID, delivered.id]).catch(() => undefined)
        if (stored) break
        await Bun.sleep(10)
      }

      expect(stored).toBeDefined()

      for (let i = 0; i < 100; i++) {
        if (SessionMessage.peekPending(sessionID).length === 0) break
        await Bun.sleep(10)
      }

      expect(SessionMessage.peekPending(sessionID).length).toBe(0)

      const fromSource = sources[0]!
      await SessionMessage.deliver({
        from: fromSource,
        to: sessionID,
        text: "source",
      })

      await Bun.sleep(25)

      const remaining = SessionMessage.peekPending(sessionID)
      expect(remaining.length).toBe(1)
      expect(remaining[0]?.from).toBe(fromSource)
    })
  })
}
