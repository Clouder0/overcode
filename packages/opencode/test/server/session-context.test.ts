import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Provider } from "../../src/provider/provider"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.context", () => {
  test("returns actions + estimate fields", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 4096, output: 512 },
        } as any)

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
          text: "hello",
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
          time: { created: now + 1, completed: now + 1 },
          finish: "end_turn",
        })

        // Insert a persisted transcript marker.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a1.id,
          type: "text",
          synthetic: true,
          ignored: true,
          text: "Trimmed 2 tool outputs (~123 tokens)",
          time: { start: now + 2, end: now + 2 },
          metadata: {
            opencode: {
              marker: {
                kind: "trim",
                at: now + 2,
                count: 2,
                tokens: 123,
              },
            },
          },
        })

        const u2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 3 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u2.id,
          type: "text",
          text: "next",
        })

        const response = await app.request(`/session/${session.id}/context`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as any
        expect(body.cpd).toBeNull()

        expect(body.actions.trim.count).toBe(2)
        expect(body.actions.trim.tokens).toBe(123)
        expect(body.actions.trim.at).toBe(now + 2)

        expect(body.estimate.target).toBe(u2.id)
        expect(typeof body.estimate.total).toBe("number")
        expect(typeof body.estimate.system).toBe("number")
        expect(typeof body.estimate.messages).toBe("number")
        expect(body.estimate.budget).not.toBeNull()
        expect(body.estimate.context).toBe(4096)

        await Session.remove(session.id)
        modelSpy.mockRestore()
      },
    })
  })
})
