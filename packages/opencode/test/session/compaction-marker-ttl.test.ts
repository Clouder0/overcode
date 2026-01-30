import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { SessionCompaction } from "../../src/session/compaction"
import { Session } from "../../src/session"
import { Global } from "../../src/global"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.compaction marker TTL", () => {
  test("expires a stale compaction marker and clears storage", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(session.id)
          },
        }

        const created = Date.now() - 11 * 60 * 1000
        await Storage.write(["compaction", session.id], {
          requestID: "msg_test",
          startedAt: created,
          time: {
            created,
          },
        })

        const marker = await SessionCompaction.marker(session.id)
        expect(marker).toBeUndefined()

        // marker() clears asynchronously; wait briefly for remove to settle.
        const cleared = await (async () => {
          for (let i = 0; i < 25; i++) {
            const existing = await Storage.read(["compaction", session.id]).catch(() => undefined)
            if (!existing) return true
            await Bun.sleep(10)
          }
          return false
        })()

        expect(cleared).toBe(true)
      },
    })
  })

  test("clears a malformed compaction marker", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(session.id)
          },
        }

        const now = Date.now()

        // Missing time.created should be treated as stale and removed.
        await Storage.write(["compaction", session.id], {
          requestID: "msg_test",
          startedAt: now,
          time: {},
        } as any)

        const marker = await SessionCompaction.marker(session.id)
        expect(marker).toBeUndefined()

        const cleared = await (async () => {
          for (let i = 0; i < 25; i++) {
            const existing = await Storage.read(["compaction", session.id]).catch(() => undefined)
            if (!existing) return true
            await Bun.sleep(10)
          }
          return false
        })()

        expect(cleared).toBe(true)
      },
    })
  })

  test("clears a corrupt compaction marker JSON", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(session.id)
          },
        }

        const file = path.join(Global.Path.data, "storage", "compaction", session.id + ".json")
        await Bun.write(file, "{not-json")

        const marker = await SessionCompaction.marker(session.id)
        expect(marker).toBeUndefined()

        const cleared = await (async () => {
          for (let i = 0; i < 25; i++) {
            if (!(await Bun.file(file).exists())) return true
            await Bun.sleep(10)
          }
          return false
        })()

        expect(cleared).toBe(true)
      },
    })
  })
})
