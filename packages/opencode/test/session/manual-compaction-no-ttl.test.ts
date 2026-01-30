import path from "path"
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionCompaction } from "../../src/session/compaction"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.compaction manual", () => {
  test("does not evict manual state by age", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const start = Date.now()
        const entry = SessionCompaction.beginManual({
          sessionID: session.id,
          requestID: "msg_test",
          startedAt: start,
        })
        expect(entry).toBeDefined()

        // Simulate time passing beyond the historical ACTIVE_TTL.
        const nowSpy = spyOn(Date, "now").mockReturnValue(start + 11 * 60 * 1000)

        expect(SessionCompaction.manual(session.id)).toBeDefined()
        expect(SessionCompaction.abortManual(session.id)).toBe(true)

        nowSpy.mockRestore()
        SessionCompaction.endManual({ sessionID: session.id, requestID: "msg_test" })
        await Session.remove(session.id)
      },
    })
  })
})
