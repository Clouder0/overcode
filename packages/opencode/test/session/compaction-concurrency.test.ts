import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionCPD } from "../../src/session/cpd"
import { Config } from "../../src/config/config"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session context maintenance concurrency", () => {
  test("adds a hidden reminder to messages created during maintenance", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          // Make budgets small so we enter maintenance.
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

        await Session.updateMessage({
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
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "end_turn",
        })

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
          text: "x".repeat(4096),
        })

        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        let captured: { delta?: string } | undefined
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          captured = { delta: input?.delta }
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

        const run = SessionPrompt.loop(session.id)
        await started

        const delivered = await SessionMessage.deliver({
          from: "ses_sender",
          to: session.id,
          text: "hello while compacting",
        })

        const human = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          parts: [{ type: "text", text: "human prompt" }],
          noReply: true,
        })

        holdResolve?.()
        await run

        cpdSpy.mockRestore()

        expect(captured?.delta).toBeDefined()
        expect(captured?.delta).not.toContain("hello while compacting")

        const reminder = await (async () => {
          for (let i = 0; i < 50; i++) {
            const parts = await MessageV2.parts(delivered.id)
            const match = parts.find((p) => {
              if (p.type !== "text") return false
              if (!p.synthetic) return false
              const meta = p.metadata as any
              return meta?.opencode?.compaction?.requestID === u2.id
            })
            if (match) return match
            await Bun.sleep(10)
          }
          return
        })()

        if (!reminder) {
          const parts = await MessageV2.parts(delivered.id)
          throw new Error(
            `missing compaction reminder. delivered=${JSON.stringify(parts)} human=${JSON.stringify(human.parts)}`,
          )
        }

        const humanReminder = human.parts.find((p) => {
          if (p.type !== "text") return false
          if (!p.synthetic) return false
          const meta = p.metadata as any
          return meta?.opencode?.compaction?.requestID === u2.id
        })
        expect(humanReminder).toBeDefined()
      },
    })
  })
})
