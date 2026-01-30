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
  test("does not allow CPD upto to move backwards", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const older = Identifier.ascending("message")
        const newer = Identifier.ascending("message")

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
        await SessionCPD.set(session.id, { text: "one", upto: upto1 })

        const file = path.join(Global.Path.data, "storage", "cpd", session.id + ".json")
        await Bun.write(file, "{not-json")

        const upto2 = Identifier.ascending("message")
        await SessionCPD.set(session.id, { text: "two", upto: upto2 })

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(upto2)
        expect(cpd?.text).toBe("two")

        await Session.remove(session.id)
      },
    })
  })
})
