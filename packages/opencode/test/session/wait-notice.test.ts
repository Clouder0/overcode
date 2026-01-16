import { beforeEach, expect, test } from "bun:test"
import "../../src/session/prompt"
import path from "node:path"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"

const projectRoot = path.join(__dirname, "../..")

const withinInstance = <T>(fn: () => T | Promise<T>) =>
  Instance.provide({
    directory: projectRoot,
    fn,
  })

beforeEach(async () => {
  await withinInstance(() => {
    SessionMessage.clear("notice_waiter")
    SessionMessage.clear("notice_source")
    SessionMessage.clear("notice_source2")
    WaitPolicy.clear("notice_waiter")
    WaitPolicy.clear("notice_waiter2")
    SessionStatus.set("notice_waiter", { type: "idle" })
    SessionStatus.set("notice_waiter2", { type: "idle" })
    SessionStatus.set("notice_source", { type: "idle" })
    SessionStatus.set("notice_source2", { type: "idle" })
  })
})

test("sends one-shot notice when waiter enters waiting and source is idle", async () => {
  await withinInstance(async () => {
    const waiter = Identifier.ascending("session")
    const source = Identifier.ascending("session")

    const delivered: string[] = []
    const unsub = Bus.subscribe(SessionMessage.Event.Delivered, (event) => {
      const msg = event.properties.message
      if (msg.to !== source) return
      if (msg.messageType !== "notice") return
      delivered.push(msg.id)
    })

    try {
      SessionStatus.set(source, { type: "idle" })

      const policy = WaitPolicy.register({
        sessionID: waiter,
        messageID: Identifier.ascending("message"),
        callID: "call_wait",
        sources: [source],
        timeout: 10_000,
        mode: "all",
        since: SessionMessage.nowSeq(),
      })

      SessionStatus.set(waiter, {
        type: "waiting",
        sources: policy.sources,
        timeout: policy.timeout,
        mode: policy.mode,
        time: policy.time,
      })

      for (let i = 0; i < 50; i++) {
        if (delivered.length > 0) break
        await Bun.sleep(10)
      }

      expect(delivered.length).toBe(1)

      // Repeat the same waiting event; should not re-notice.
      SessionStatus.set(waiter, {
        type: "waiting",
        sources: policy.sources,
        timeout: policy.timeout,
        mode: policy.mode,
        time: policy.time,
      })

      await Bun.sleep(25)
      expect(delivered.length).toBe(1)
    } finally {
      unsub()
      WaitPolicy.clear(waiter)
      WaitPolicy.clear(source)
    }
  })
})

test("does not count notice messages as responses for wildcard waits", async () => {
  await withinInstance(async () => {
    const waiter = Identifier.ascending("session")
    const since = SessionMessage.nowSeq()

    const policy = WaitPolicy.register({
      sessionID: waiter,
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
      to: waiter,
      text: "notice",
      messageType: "notice",
    })

    const respondedFromSources = SessionMessage.responded({
      to: waiter,
      sources: policy.sources,
      since: policy.since,
    })

    const result = WaitPolicy.evaluate({
      policy,
      respondedFromSources,
    })

    expect(result.ready).toBe(false)
    expect(respondedFromSources.size).toBe(0)

    WaitPolicy.clear(waiter)
  })
})

test("aggregates multiple waiters when a source becomes idle", async () => {
  await withinInstance(async () => {
    const source = Identifier.ascending("session")
    const waiterA = Identifier.ascending("session")
    const waiterB = Identifier.ascending("session")

    const delivered: string[] = []
    const unsub = Bus.subscribe(SessionMessage.Event.Delivered, (event) => {
      const msg = event.properties.message
      if (msg.to !== source) return
      if (msg.messageType !== "notice") return
      delivered.push(msg.text)
    })

    try {
      SessionStatus.set(source, { type: "busy" })

      const policyA = WaitPolicy.register({
        sessionID: waiterA,
        messageID: Identifier.ascending("message"),
        callID: "call_a",
        sources: [source],
        timeout: 10_000,
        mode: "all",
        since: SessionMessage.nowSeq(),
      })

      const policyB = WaitPolicy.register({
        sessionID: waiterB,
        messageID: Identifier.ascending("message"),
        callID: "call_b",
        sources: [source],
        timeout: 10_000,
        mode: "all",
        since: SessionMessage.nowSeq(),
      })

      SessionStatus.set(waiterA, {
        type: "waiting",
        sources: policyA.sources,
        timeout: policyA.timeout,
        mode: policyA.mode,
        time: policyA.time,
      })

      SessionStatus.set(waiterB, {
        type: "waiting",
        sources: policyB.sources,
        timeout: policyB.timeout,
        mode: policyB.mode,
        time: policyB.time,
      })

      // Transition source to idle triggers aggregation.
      SessionStatus.set(source, { type: "idle" })

      for (let i = 0; i < 50; i++) {
        if (delivered.length > 0) break
        await Bun.sleep(10)
      }

      expect(delivered.length).toBe(1)
      expect(delivered[0] ?? "").toContain(waiterA)
      expect(delivered[0] ?? "").toContain(waiterB)
    } finally {
      unsub()
      WaitPolicy.clear(waiterA)
      WaitPolicy.clear(waiterB)
      WaitPolicy.clear(source)
    }
  })
})
