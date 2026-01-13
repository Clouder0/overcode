import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { Provider } from "../../src/provider/provider"
import { SessionMessage } from "../../src/session/message-routing"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.compaction concurrency", () => {
  test("uses compaction task messageID as parentID", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          limit: { context: 8192, output: 4096 },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()

        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1 },
          finish: "end_turn",
        })

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: false,
        })

        const delivered = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 3 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: delivered.id,
          sessionID: session.id,
          type: "message",
          direction: "incoming",
          peer: "ses_test",
          peerType: "agent",
          text: "hi from agent",
          time: { created: now + 3 },
        })

        let captured: any
        const compactionSpy = spyOn(SessionCompaction, "process").mockImplementation(async (input: any) => {
          captured = input
          return "stop"
        })

        await SessionPrompt.loop(session.id)

        compactionSpy.mockRestore()

        expect(captured).toBeDefined()
        expect(captured.parentID).toBe(compactReq.id)
        expect(captured.messages.some((m: any) => m.info.id === delivered.id)).toBe(false)
        expect(captured.messages.at(-1)?.info.id).toBe(compactReq.id)
      },
    })
  })

  test("adds a hidden reminder to messages created during compaction", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          limit: { context: 8192, output: 4096 },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()

        const user1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user1.id,
          sessionID: session.id,
          type: "text",
          text: "hello",
        })

        await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: user1.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1 },
          finish: "end_turn",
        })

        const compactReq = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: compactReq.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
        })

        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const compactionSpy = spyOn(SessionCompaction, "process").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return "stop"
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

        compactionSpy.mockRestore()

        const deliveredReminder = await (async () => {
          for (let i = 0; i < 50; i++) {
            const parts = await MessageV2.parts(delivered.id)
            const match = parts.find((p) => {
              if (p.type !== "text") return false
              if (!p.synthetic) return false
              const meta = p.metadata as any
              return meta?.opencode?.compaction?.requestID === compactReq.id
            })
            if (match) return match
            await Bun.sleep(10)
          }
          return
        })()

        if (!deliveredReminder) {
          const parts = await MessageV2.parts(delivered.id)
          throw new Error(
            `missing delivered compaction reminder. delivered=${JSON.stringify(parts)} human=${JSON.stringify(human.parts)}`,
          )
        }

        const humanReminder = human.parts.find((p) => {
          if (p.type !== "text") return false
          if (!p.synthetic) return false
          const meta = p.metadata as any
          return meta?.opencode?.compaction?.requestID === compactReq.id
        })

        expect(humanReminder).toBeDefined()
      },
    })
  })
})
