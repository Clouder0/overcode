import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import "../../src/session/prompt"

import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
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
          since: SessionMessage.nowSeq(waiter.id),
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

test("normalizes targeted mode=any waits and sends notice", async () => {
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
          callID: "call_wait_any",
          sources: [source.id],
          timeout: 10_000,
          mode: "any",
          since: SessionMessage.nowSeq(waiter.id),
        })

        expect(policy.mode).toBe("all")

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await Bun.sleep(50)
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

test("does not send notice for multi-source mode=any waits", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const waiter = await Session.create({})
      const sourceA = await Session.create({})
      const sourceB = await Session.create({})

      const delivered: string[] = []
      const unsub = Bus.subscribe(SessionMessage.Event.Delivered, (event) => {
        const msg = event.properties.message
        if (msg.to !== sourceA.id && msg.to !== sourceB.id) return
        if (msg.messageType !== "notice") return
        delivered.push(msg.id)
      })

      try {
        SessionStatus.set(sourceA.id, { type: "idle" })
        SessionStatus.set(sourceB.id, { type: "idle" })

        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: Identifier.ascending("message"),
          callID: "call_wait_any_multi",
          sources: [sourceA.id, sourceB.id],
          timeout: 10_000,
          mode: "any",
          since: SessionMessage.nowSeq(waiter.id),
        })

        expect(policy.mode).toBe("any")

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await Bun.sleep(50)
        expect(delivered.length).toBe(0)
      } finally {
        unsub()
        WaitPolicy.clear(waiter.id)
        WaitPolicy.clear(sourceA.id)
        WaitPolicy.clear(sourceB.id)
        SessionStatus.set(waiter.id, { type: "idle" })
        SessionStatus.set(sourceA.id, { type: "idle" })
        SessionStatus.set(sourceB.id, { type: "idle" })
        await Session.remove(sourceB.id)
        await Session.remove(sourceA.id)
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
      const since = SessionMessage.nowSeq(waiter.id)

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

test("notice message does not interrupt waiting session when source has not responded", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const waiter = await Session.create({})
      const source = await Session.create({})

      try {
        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: waiter.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: waiter.id,
          messageID: userID,
          type: "text",
          text: "seed",
        })

        const waitMsgID = Identifier.ascending("message")
        await Session.updateMessage({
          id: waitMsgID,
          sessionID: waiter.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-4",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: {
            created: now,
            completed: now,
          },
          finish: "tool-calls",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: waiter.id,
          messageID: waitMsgID,
          type: "tool",
          callID: "call_wait",
          tool: "wait_agent_message",
          state: {
            status: "completed",
            input: {
              sources: [source.id],
              timeout: 10_000,
              mode: "all",
              since: SessionMessage.nowSeq(waiter.id),
            },
            output: "wait",
            title: "wait",
            metadata: {},
            time: {
              start: now,
              end: now,
            },
          },
        })

        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: waitMsgID,
          callID: "call_wait",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(waiter.id),
        })

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await SessionMessage.deliver({
          from: "Wait notice",
          to: waiter.id,
          text: "notice",
          messageType: "notice",
        })

        for (let i = 0; i < 100; i++) {
          if (!WaitPolicy.isWaiting(waiter.id)) break
          await Bun.sleep(10)
        }

        expect(WaitPolicy.isWaiting(waiter.id)).toBe(true)
        expect(SessionStatus.get(waiter.id).type).toBe("waiting")
      } finally {
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

test("wildcard wait treats normal incoming message as source response", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const waiter = await Session.create({})
      const source = await Session.create({})

      try {
        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: waiter.id,
          role: "user",
          time: { created: now },
          agent: "build",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: waiter.id,
          messageID: userID,
          type: "text",
          text: "seed",
        })

        const waitMsgID = Identifier.ascending("message")
        await Session.updateMessage({
          id: waitMsgID,
          sessionID: waiter.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-4",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: {
            created: now,
            completed: now,
          },
          finish: "tool-calls",
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: waiter.id,
          messageID: waitMsgID,
          type: "tool",
          callID: "call_wait",
          tool: "wait_agent_message",
          state: {
            status: "completed",
            input: {
              sources: ["*"],
              timeout: 10_000,
              mode: "all",
              since: SessionMessage.nowSeq(waiter.id),
            },
            output: "wait",
            title: "wait",
            metadata: {},
            time: {
              start: now,
              end: now,
            },
          },
        })

        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: waitMsgID,
          callID: "call_wait",
          sources: ["*"],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(waiter.id),
        })

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await SessionMessage.deliver({
          from: source.id,
          to: waiter.id,
          text: "reply",
        })

        for (let i = 0; i < 100; i++) {
          const parts = await MessageV2.parts(waitMsgID)
          const waitPart = parts.find((part): part is MessageV2.ToolPart => {
            if (part.type !== "tool") return false
            return part.callID === "call_wait"
          })
          const interrupted = (() => {
            if (!waitPart?.state) return false
            if (!("metadata" in waitPart.state)) return false
            return (waitPart.state.metadata as any)?.interrupted === true
          })()
          if (!WaitPolicy.isWaiting(waiter.id) && !interrupted) break
          await Bun.sleep(10)
        }

        const parts = await MessageV2.parts(waitMsgID)
        const waitPart = parts.find((part): part is MessageV2.ToolPart => {
          if (part.type !== "tool") return false
          return part.callID === "call_wait"
        })
        const finalInterrupted = (() => {
          if (!waitPart?.state) return false
          if (!("metadata" in waitPart.state)) return false
          return (waitPart.state.metadata as any)?.interrupted === true
        })()
        expect(finalInterrupted).toBe(false)
      } finally {
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
          since: SessionMessage.nowSeq(waiterA.id),
        })

        const policyB = WaitPolicy.register({
          sessionID: waiterB.id,
          messageID: Identifier.ascending("message"),
          callID: "call_b",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(waiterB.id),
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

test("does not send idle notice when source is busy in another directory", async () => {
  await using tmp = await tmpdir({ git: true })
  const root = tmp.path
  const sub = `${tmp.path}/subdir`
  await fs.mkdir(sub, { recursive: true })

  await Instance.provide({
    directory: root,
    fn: async () => {
      const waiter = await Session.create({})
      const source = await Instance.provide({
        directory: sub,
        fn: async () => {
          return Session.create({})
        },
      })

      try {
        await Instance.provide({
          directory: sub,
          fn: async () => {
            SessionStatus.set(source.id, { type: "busy" })
          },
        })

        const policy = WaitPolicy.register({
          sessionID: waiter.id,
          messageID: Identifier.ascending("message"),
          callID: "call_cross_dir_wait",
          sources: [source.id],
          timeout: 10_000,
          mode: "all",
          since: SessionMessage.nowSeq(waiter.id),
        })

        SessionStatus.set(waiter.id, {
          type: "waiting",
          sources: policy.sources,
          timeout: policy.timeout,
          mode: policy.mode,
          since: policy.since,
          time: policy.time,
        })

        await Bun.sleep(80)

        const pending = await Instance.provide({
          directory: sub,
          fn: async () => {
            return SessionMessage.peekPending(source.id)
          },
        })

        expect(pending.some((msg) => msg.messageType === "notice")).toBe(false)
      } finally {
        WaitPolicy.clear(waiter.id)
        SessionStatus.set(waiter.id, { type: "idle" })
        await Session.remove(waiter.id)

        await Instance.provide({
          directory: sub,
          fn: async () => {
            WaitPolicy.clear(source.id)
            SessionStatus.set(source.id, { type: "idle" })
            await Session.remove(source.id)
          },
        })
      }
    },
  })
})
