import { afterEach, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCPD } from "../../src/session/cpd"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("Session.messages orders by persistence, not by message id", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      const now = Date.now()

      await Session.updateMessage({
        id: "msg_z",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now },
      })

      await Session.updateMessage({
        id: "msg_a",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now + 1 },
      })

      const msgs = await Session.messages({ sessionID: session.id })
      expect(msgs.map((m) => m.info.id)).toEqual(["msg_z", "msg_a"])

      await Session.remove(session.id)
    },
  })
})

test("SessionCPD does not allow upto to move backwards when ids are out of order", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      const now = Date.now()

      await Session.updateMessage({
        id: "msg_z",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now },
      })

      await Session.updateMessage({
        id: "msg_a",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now + 1 },
      })

      await SessionCPD.set(session.id, { text: "new", upto: "msg_a" })
      await SessionCPD.set(session.id, { text: "old", upto: "msg_z" })

      const cpd = await SessionCPD.get(session.id)
      expect(cpd?.upto).toBe("msg_a")
      expect(cpd?.text).toBe("new")

      await Session.remove(session.id)
    },
  })
})

test("Session.fork assigns fresh orders and continues incrementing", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      const now = Date.now()

      await Session.updateMessage({
        id: "msg_a",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now },
      })

      await Session.updateMessage({
        id: "msg_b",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now + 1 },
      })

      const fork = await Session.fork({ sessionID: session.id })

      await Session.updateMessage({
        id: "msg_c",
        role: "user",
        sessionID: fork.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now + 2 },
      })

      const forkMsgs = await Session.messages({ sessionID: fork.id })
      expect(forkMsgs.map((m) => m.info.order)).toEqual([1, 2, 3])

      await Session.remove(fork.id)
      await Session.remove(session.id)
    },
  })
})

test("next message order seeds from existing messages when counter is missing", async () => {
  await using tmp = await tmpdir({ git: true })

  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const now = Date.now()

      await Session.updateMessage({
        id: "msg_a",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now },
      })

      await Session.updateMessage({
        id: "msg_b",
        role: "user",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now + 1 },
      })

      await Storage.remove(["message_order", session.id]).catch(() => {})
      await Instance.dispose()
      return session.id
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const now = Date.now()
      await Session.updateMessage({
        id: "msg_c",
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
        time: { created: now },
      })

      const msgs = await Session.messages({ sessionID })
      expect(msgs.map((m) => m.info.order)).toEqual([1, 2, 3])
      await Session.remove(sessionID)
    },
  })
})

test("Session.messages places missing order after ordered messages", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})

      const now = Date.now()

      await Storage.write(["message", session.id, "msg_ordered"], {
        id: "msg_ordered",
        sessionID: session.id,
        role: "user",
        order: 1,
        time: { created: now },
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
      })

      await Storage.write(["message", session.id, "msg_missing"], {
        id: "msg_missing",
        sessionID: session.id,
        role: "user",
        time: { created: now + 1 },
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
      })

      const msgs = await Session.messages({ sessionID: session.id })
      expect(msgs.map((m) => m.info.id)).toEqual(["msg_ordered", "msg_missing"])

      await Session.remove(session.id)
    },
  })
})
