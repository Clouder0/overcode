import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionRevert } from "../../src/session/revert"
import { SessionCPD } from "../../src/session/cpd"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.revert + CPD", () => {
  test("cleanup clears CPD when revert removes content included in CPD", async () => {
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

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: u1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "end_turn",
        } as any)

        const u2 = await Session.updateMessage({
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
          messageID: u2.id,
          type: "text",
          text: "u2",
        })

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: u2.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 3, completed: now + 3 },
          finish: "end_turn",
        } as any)

        await SessionCPD.set(session.id, { text: "cpd", upto: u2.id })

        await SessionRevert.revert({ sessionID: session.id, messageID: u2.id })
        const info = await Session.get(session.id)
        expect(info.revert?.messageID).toBeDefined()

        await SessionRevert.cleanup(info)

        expect(await SessionCPD.get(session.id)).toBeUndefined()
        const after = await Session.get(session.id)
        expect(after.context?.cpd).toBeUndefined()
        expect(after.context?.trim).toBe(false)
        expect(after.context?.think).toBe(false)
        expect(after.context?.rctx).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("cleanup keeps CPD when revert only removes messages after CPD boundary", async () => {
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

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: u1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "end_turn",
        } as any)

        const u2 = await Session.updateMessage({
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
          messageID: u2.id,
          type: "text",
          text: "u2",
        })

        await SessionCPD.set(session.id, { text: "cpd", upto: u1.id })

        await SessionRevert.revert({ sessionID: session.id, messageID: u2.id })
        const info = await Session.get(session.id)
        await SessionRevert.cleanup(info)

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(u1.id)

        await Session.remove(session.id)
      },
    })
  })
})
