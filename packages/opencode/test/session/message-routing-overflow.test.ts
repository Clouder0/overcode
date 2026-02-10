import path from "node:path"
import { expect, test } from "bun:test"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { SessionMessage } from "../../src/session/message-routing"

const projectRoot = path.join(__dirname, "../..")

const withinInstance = <T>(fn: () => T | Promise<T>) =>
  Instance.provide({
    directory: projectRoot,
    fn,
  })

test("emits overflow signal when pending queue exceeds cap", async () => {
  await withinInstance(async () => {
    const to = "ses_overflow_target"
    const overflow = SessionMessage.Event.Overflow

    const events: {
      droppedCount: number
      droppedIDs: string[]
      maxPending: number
      to: string
    }[] = []
    const unsubscribe = Bus.subscribe(overflow, (event) => {
      events.push(event.properties)
    })

    try {
      for (let i = 0; i < 205; i++) {
        await SessionMessage.deliver({
          from: `ses_src_${i}`,
          to,
          text: `m${i}`,
        })
      }
    } finally {
      unsubscribe()
      SessionMessage.clear(to)
    }

    expect(events.length).toBeGreaterThan(0)
    const latest = events[events.length - 1]!
    expect(latest.to).toBe(to)
    expect(latest.maxPending).toBe(200)
    expect(latest.droppedCount).toBe(1)
    expect(latest.droppedIDs.length).toBe(1)
  })
})

test("clear() drops inbox seq state for removed session", async () => {
  await withinInstance(async () => {
    const to = "ses_clear_target"
    const from = "ses_clear_source"

    await SessionMessage.deliver({
      from,
      to,
      text: "hello",
    })

    expect(SessionMessage.lastSeq(to, from)).toBeGreaterThan(0)

    SessionMessage.clear(to)

    expect(SessionMessage.lastSeq(to, from)).toBe(0)
  })
})

test("respondedRecoverable excludes dropped undurable source replies", async () => {
  await withinInstance(async () => {
    const prev = SessionMessage.setWakeSessionFn(undefined)
    const to = "ses_wait_target"
    const source = "ses_wait_source"
    const since = SessionMessage.nowSeq(to)

    try {
      const reply = await SessionMessage.deliver({
        from: source,
        to,
        text: "reply",
      })

      for (let i = 0; i < 260; i++) {
        await SessionMessage.deliver({
          from: `ses_noise_${i}`,
          to,
          text: String(i),
        })
      }

      const pending = SessionMessage.peekPending(to)
      expect(pending.some((msg) => msg.id === reply.id)).toBe(false)

      const before = SessionMessage.respondedRecoverable({
        to,
        sources: [source],
        since,
      })

      expect(before.has(source)).toBe(false)

      SessionMessage.markDurable(reply)

      const after = SessionMessage.respondedRecoverable({
        to,
        sources: [source],
        since,
      })

      expect(after.has(source)).toBe(true)
    } finally {
      SessionMessage.setWakeSessionFn(prev)
    }
  })
})
