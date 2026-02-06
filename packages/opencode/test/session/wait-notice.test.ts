import { expect, test } from "bun:test"
import "../../src/session/prompt"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

test("sends one-shot notice when waiter enters waiting and source is idle", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const waiter = await Session.create({})
      const source = await Session.create({})

      const delivered: string[] = []
      const unsub = Bus.subscribe(SessionMessage.Event.Delivered, (event) => {
        const msg = event.properties.message
        if (msg.to !== source.id) return
        if (msg.messageType !== "notice") return
        delivered.push(msg.id)
      })

      try {
        SessionStatus.set(source.id, { type: "idle" })

        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: Identifier.ascending("message"),
          callID: "call_wait",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(),
        })

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        for (let i = 0; i < 50; i++) {
          if (delivered.length > 0) break
          await Bun.sleep(10)
        }

        expect(delivered.length).toBe(1)

        // Repeat the same waiting event; should not re-notice.
        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await Bun.sleep(25)
        expect(delivered.length).toBe(1)
      } finally {
        unsub()
        WaitPolicy.clear(waiter.id)
        WaitPolicy.clear(source.id)
        SessionStatus.set(waiter.id, { type: "idle" })
        SessionStatus.set(source.id, { type: "idle" })
        await Session.remove(source.id)
        await Session.remove(waiter.id)
      }
    },
  })
})

test("does not count notice messages as responses for wildcard waits", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const waiter = await Session.create({})
      const since = SessionMessage.nowSeq()

      try {
        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: Identifier.ascending("message"),
          callID: "call_wait",
          sources: ["*"],
          timeout: 10_000,
          mode: "any",
          since,
        })

        // Deliver a notice to the waiting session.
        await SessionMessage.deliver({
          from: "Wait notice",
          to: waiter.id,
          text: "notice",
          messageType: "notice",
        })

        const respondedFromSources = SessionMessage.responded({
          to: waiter.id,
          sources: policy.sources,
          since: policy.since,
        })

        const result = WaitPolicy.evaluate({
          policy,
          respondedFromSources,
        })

        expect(result.ready).toBe(false)
        expect(respondedFromSources.size).toBe(0)
      } finally {
        WaitPolicy.clear(waiter.id)
        SessionStatus.set(waiter.id, { type: "idle" })
        await Session.remove(waiter.id)
      }
    },
  })
})

test("aggregates multiple waiters when a source becomes idle", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const source = await Session.create({})
      const waiterA = await Session.create({})
      const waiterB = await Session.create({})

      const delivered: string[] = []
      const unsub = Bus.subscribe(SessionMessage.Event.Delivered, (event) => {
        const msg = event.properties.message
        if (msg.to !== source.id) return
        if (msg.messageType !== "notice") return
        delivered.push(msg.text)
      })

      try {
        SessionStatus.set(source.id, { type: "busy" })

        const policyA = WaitPolicy.register({
          sessionID: waiterA.id,
          messageID: Identifier.ascending("message"),
          callID: "call_a",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(),
        })

        const policyB = WaitPolicy.register({
          sessionID: waiterB.id,
          messageID: Identifier.ascending("message"),
          callID: "call_b",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(),
        })

        SessionStatus.set(waiterA.id, {
          type: "waiting",
          sources: policyA.sources,
          timeout: policyA.timeout,
          mode: policyA.mode,
          since: policyA.since,
          time: policyA.time,
        })

        SessionStatus.set(waiterB.id, {
          type: "waiting",
          sources: policyB.sources,
          timeout: policyB.timeout,
          mode: policyB.mode,
          since: policyB.since,
          time: policyB.time,
        })

        // Transition source to idle triggers aggregation.
        SessionStatus.set(source.id, { type: "idle" })

        for (let i = 0; i < 50; i++) {
          if (delivered.length > 0) break
          await Bun.sleep(10)
        }

        expect(delivered.length).toBe(1)
        expect(delivered[0] ?? "").toContain(waiterA.id)
        expect(delivered[0] ?? "").toContain(waiterB.id)
      } finally {
        unsub()
        WaitPolicy.clear(waiterA.id)
        WaitPolicy.clear(waiterB.id)
        WaitPolicy.clear(source.id)
        SessionStatus.set(waiterA.id, { type: "idle" })
        SessionStatus.set(waiterB.id, { type: "idle" })
        SessionStatus.set(source.id, { type: "idle" })
        await Session.remove(waiterB.id)
        await Session.remove(waiterA.id)
        await Session.remove(source.id)
      }
    },
  })
})
