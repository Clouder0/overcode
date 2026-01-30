import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionCPD } from "../../src/session/cpd"
import { Log } from "../../src/util/log"
import { NamedError } from "@opencode-ai/util/error"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.summarize", () => {
  test("advances CPD past completed assistant errors", async () => {
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

        const error = new NamedError.Unknown({ message: "failed" }).toObject()

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
          // Note: finish is intentionally omitted; errors must still count as answered.
          error,
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

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })
        expect(response.status).toBe(200)

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(u1.id)

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("treats bootstrap synthetic user text as relevant (prevents no-op)", async () => {
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

        // Matches SessionPrompt's subagent bootstrap behavior.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u1.id,
          type: "text",
          text: "Begin your task as specified in the system prompt.",
          synthetic: true,
          metadata: { opencode: { bootstrap: true } },
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

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })
        expect(response.status).toBe(200)

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(u1.id)

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("writes an rctx marker when CPD update reports rctx (first occurrence)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: true })
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

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })
        expect(response.status).toBe(200)

        const info = await Session.get(session.id)
        expect(info.context?.rctx).toBe(true)

        const msgs = await Session.messages({ sessionID: session.id })
        const marker = msgs
          .flatMap((m) => m.parts)
          .find((p) => {
            if (p.type !== "text") return false
            if (p.ignored !== true) return false
            const meta = p.metadata as any
            return meta?.opencode?.marker?.kind === "rctx"
          })

        expect(marker).toBeDefined()

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })
})
