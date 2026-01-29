import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { SessionCPD } from "../../src/session/cpd"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt CPD delta ordering", () => {
  test("includes assistant replies that come before the target user in turn-order", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          // Keep the budget tiny so we trigger maintenance and then fail preflight
          // (avoids reaching the LLM call path).
          limit: { context: 256, output: 200 },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

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
          text: "x".repeat(4096),
        })

        // Create the assistant reply to u1 *after* u2 so its id is greater, but it still
        // belongs in the prefix delta when targeting u2.
        const a1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: u1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: { created: now + 2, completed: now + 2 },
          finish: "end_turn",
        } as any)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a1.id,
          type: "text",
          text: "assistant reply",
        })

        let captured: { delta?: string } | undefined
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          captured = { delta: input?.delta }
          return { text: "cpd", rctx: false }
        })

        await SessionPrompt.loop(session.id)

        cpdSpy.mockRestore()

        expect(captured?.delta).toBeDefined()
        expect(captured?.delta).toContain("assistant reply")
      },
    })
  })
})
