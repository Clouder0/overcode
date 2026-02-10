import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionCPD } from "../../src/session/cpd"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.summarize covered batch users", () => {
  test("treats batch-covered users as answered for manual compaction target", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })
        const app = Server.App()
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
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u2.id,
          type: "text",
          text: "u2",
        })

        const a1 = await Session.updateMessage({
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
          time: { created: now + 2, completed: now + 2 },
          finish: "end_turn",
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a1.id,
          type: "text",
          synthetic: true,
          ignored: true,
          text: "",
          metadata: {
            opencode: {
              batch: {
                users: [u1.id, u2.id],
                anchor: u1.id,
              },
            },
          },
        })

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        expect(response.status).toBe(200)
        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(u2.id)

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })
})
