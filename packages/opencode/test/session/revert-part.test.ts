import path from "path"
import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionRevert } from "../../src/session/revert"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.revert part boundary", () => {
  test("cleanup preserves boundary message and removes parts from partID onwards", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const now = Date.now()

        const u1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u1.id,
          type: "text",
          text: "u1",
        })

        const u2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 1 },
        })

        const keep = await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u2.id,
          type: "text",
          text: "keep",
        })

        const cut = await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u2.id,
          type: "text",
          text: "cut",
        })

        const after = await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u2.id,
          type: "text",
          text: "after",
        })

        const u3 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u3.id,
          type: "text",
          text: "u3",
        })

        await SessionRevert.revert({
          sessionID: session.id,
          messageID: u2.id,
          partID: cut.id,
        })
        const info = await Session.get(session.id)
        await SessionRevert.cleanup(info)

        const msgs = await Session.messages({ sessionID: session.id })
        const ids = msgs.map((m) => m.info.id)
        expect(ids).toEqual([u1.id, u2.id])

        const boundary = msgs.find((m) => m.info.id === u2.id)
        expect(boundary).toBeDefined()
        expect(boundary?.parts.map((p) => p.id)).toEqual([keep.id])

        // Ensure the trimmed parts are actually gone.
        expect(boundary?.parts.some((p) => p.id === cut.id)).toBe(false)
        expect(boundary?.parts.some((p) => p.id === after.id)).toBe(false)

        await Session.remove(session.id)
      },
    })
  })
})
