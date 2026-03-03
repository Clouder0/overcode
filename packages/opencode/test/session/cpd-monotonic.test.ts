import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { spyOn } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionCPD } from "../../src/session/cpd"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { Global } from "../../src/global"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.cpd monotonic", () => {
  test("allows legacy orderless upto messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const upto = Identifier.ascending("message")
        const now = Date.now()

        await Storage.write(["message", session.id, upto], {
          id: upto,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })

        await SessionCPD.set(session.id, { text: "legacy", upto })

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(upto)
        expect(cpd?.uptoOrder).toBeUndefined()
        expect(cpd?.text).toBe("legacy")

        await Session.remove(session.id)
      },
    })
  })

  test("does not allow CPD upto to move backwards", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const older = Identifier.ascending("message")
        const newer = Identifier.ascending("message")

        const now = Date.now()
        await Session.updateMessage({
          id: older,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updateMessage({
          id: newer,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })

        await SessionCPD.set(session.id, { text: "new", upto: newer })
        await SessionCPD.set(session.id, { text: "old", upto: older })

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(newer)
        expect(cpd?.text).toBe("new")

        await Session.remove(session.id)
      },
    })
  })

  test("uses an atomic storage upsert under concurrency", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const upsertSpy = spyOn(Storage, "upsert")

        const session = await Session.create({})

        const older = Identifier.ascending("message")
        const newer = Identifier.ascending("message")

        const now = Date.now()
        await Session.updateMessage({
          id: older,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updateMessage({
          id: newer,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })

        await Promise.all([
          SessionCPD.set(session.id, { text: "new", upto: newer }),
          SessionCPD.set(session.id, { text: "old", upto: older }),
        ])

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(newer)
        expect(upsertSpy).toHaveBeenCalled()

        upsertSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("recovers from corrupted CPD JSON on set", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const upto1 = Identifier.ascending("message")
        const now = Date.now()
        await Session.updateMessage({
          id: upto1,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await SessionCPD.set(session.id, { text: "one", upto: upto1 })

        const file = path.join(Global.Path.data, "storage", "cpd", session.id + ".json")
        await Bun.write(file, "{not-json")

        const upto2 = Identifier.ascending("message")
        await Session.updateMessage({
          id: upto2,
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })
        await SessionCPD.set(session.id, { text: "two", upto: upto2 })

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(upto2)
        expect(cpd?.text).toBe("two")

        await Session.remove(session.id)
      },
    })
  })
})
