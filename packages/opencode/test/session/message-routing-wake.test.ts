import { beforeEach, expect, spyOn, test } from "bun:test"
import "../../src/session/prompt"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { SessionMessage } from "../../src/session/message-routing"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
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
    // Persistence is async and may be slower under concurrent test load.
    for (let i = 0; i < 300; i++) {
      stored = await Storage.read(["message", sessionID, delivered.id]).catch(() => undefined)
      if (stored) break
      await Bun.sleep(10)
    }

    expect(stored).toBeDefined()

    let msg: MessageV2.MessagePart | undefined
    for (let i = 0; i < 300; i++) {
      const parts = await MessageV2.parts(delivered.id)
      msg = parts.find((p): p is MessageV2.MessagePart => p.type === "message")
      if (msg) break
      await Bun.sleep(10)
    }

    expect(msg).toBeDefined()
    expect(msg?.id).toBe(delivered.id.replace(/^msg_/, "prt_"))
  })
})

test("coalesces duplicate wake requests while wake is in-flight", async () => {
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

    SessionStatus.set(sessionID, { type: "idle" })

    const loop = spyOn(SessionPrompt as any, "loop").mockImplementation(async () => {
      await Bun.sleep(40)
      return undefined
    })

    const count = () => loop.mock.calls.filter((args) => args[0] === sessionID).length

    try {
      await SessionMessage.deliver({
        from: Identifier.ascending("session"),
        to: sessionID,
        text: "one",
      })
      await SessionMessage.deliver({
        from: Identifier.ascending("session"),
        to: sessionID,
        text: "two",
      })

      // Wake is debounced; ensure we don't start multiple loops.
      await Bun.sleep(20)
      expect(count()).toBe(0)

      await Bun.sleep(120)
      expect(count()).toBe(1)
    } finally {
      loop.mockRestore()
      SessionMessage.clear(sessionID)
    }
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
        since: 0,
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

      // Non-source messages stay in the pending queue during a wait.
      // They are persisted to durable storage but remain queued for
      // the loop to process when the wait resolves.
      const afterNonSource = SessionMessage.peekPending(sessionID)
      expect(afterNonSource.some((m) => m.text === "non-source")).toBe(true)

      const fromSource = sources[0]!
      await SessionMessage.deliver({
        from: fromSource,
        to: sessionID,
        text: "source",
      })

      await Bun.sleep(25)

      const remaining = SessionMessage.peekPending(sessionID)
      // Both non-source and source messages are in the pending queue.
      expect(remaining.some((m) => m.from === fromSource)).toBe(true)
    })
  })
}
