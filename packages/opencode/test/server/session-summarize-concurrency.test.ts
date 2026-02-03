import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionCPD } from "../../src/session/cpd"
import { SessionMessage } from "../../src/session/message-routing"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionStatus } from "../../src/session/status"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.summarize concurrency", () => {
  test("does not wake prompt loop during /summarize before manual lock is acquired", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let cleanupReachedResolve: (() => void) | undefined
        const cleanupReached = new Promise<void>((resolve) => {
          cleanupReachedResolve = resolve
        })

        const cleanupSpy = spyOn(SessionRevert, "cleanup").mockImplementation(async () => {
          cleanupReachedResolve?.()
          await hold
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          return { text: "cpd", rctx: false }
        })

        const loopSpy = spyOn(SessionPrompt as any, "loop").mockImplementation(async () => {})

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await cleanupReached

        await SessionMessage.deliver({
          from: "ses_sender",
          to: session.id,
          text: "hello before lock",
        })

        await Bun.sleep(25)
        expect(loopSpy).toHaveBeenCalledTimes(0)

        holdResolve?.()
        await run

        cleanupSpy.mockRestore()
        cpdSpy.mockRestore()
        loopSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("returns 409 when manual /summarize overlaps", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const run1 = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const run2 = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        expect(run2.status).toBe(409)

        holdResolve?.()
        const res1 = await run1
        expect(res1.status).toBe(200)

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("adds a compaction reminder to delivered messages during manual /summarize", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const delivered = await SessionMessage.deliver({
          from: "ses_sender",
          to: session.id,
          text: "hello while compacting",
        })

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
          throw new Error(`missing compaction reminder. delivered=${JSON.stringify(parts)}`)
        }

        holdResolve?.()
        await run

        cpdSpy.mockRestore()

        expect(captured?.delta).toBeDefined()
        expect(captured?.delta).not.toContain("hello while compacting")

        await Session.remove(session.id)
      },
    })
  })

  test("delivered message reminder omits requestID while summarize request is pending", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        const originalMessages = Session.messages
        const messagesSpy = spyOn(Session as any, "messages").mockImplementation(async (input: any) => {
          await hold
          return originalMessages(input)
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        const pending = await (async () => {
          for (let i = 0; i < 50; i++) {
            const active = SessionCompaction.manual(session.id)
            if (active) return active
            await Bun.sleep(5)
          }
        })()

        if (!pending) throw new Error("manual compaction did not start")

        const delivered = await SessionMessage.deliver({
          from: "ses_sender",
          to: session.id,
          text: "hello during pending",
        })

        const reminder = await (async () => {
          for (let i = 0; i < 50; i++) {
            const parts = await MessageV2.parts(delivered.id)
            const match = parts.find((p): p is MessageV2.TextPart => {
              if (p.type !== "text") return false
              if (!p.synthetic) return false
              const meta = p.metadata as any
              return meta?.opencode?.compaction?.pending === true
            })
            if (match) return match
            await Bun.sleep(10)
          }
        })()

        if (!reminder) throw new Error("missing compaction reminder")
        const reminderMeta = reminder.metadata as any
        expect(reminderMeta?.opencode?.compaction?.pending).toBe(true)
        expect(reminderMeta?.opencode?.compaction?.requestID).toBeUndefined()
        expect(reminder.text.includes("This message arrived while the session was compacting.")).toBe(true)
        expect(reminder.text.includes("Compaction request:")).toBe(false)

        holdResolve?.()
        await run

        messagesSpy.mockRestore()
        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("rejects /message during manual /summarize without persisting a user message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const before = await Session.messages({ sessionID: session.id })
        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const response = await app.request(`/session/${session.id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "dummy", modelID: "dummy" },
            parts: [{ type: "text", text: "hello" }],
          }),
        })
        expect(response.status).toBe(409)

        const after = await Session.messages({ sessionID: session.id })
        expect(after.length).toBe(before.length)

        holdResolve?.()
        await run

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("rejects /prompt_async during manual /summarize without persisting a user message", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const before = await Session.messages({ sessionID: session.id })
        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const response = await app.request(`/session/${session.id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "dummy", modelID: "dummy" },
            parts: [{ type: "text", text: "hello" }],
          }),
        })
        expect(response.status).toBe(409)

        const after = await Session.messages({ sessionID: session.id })
        expect(after.length).toBe(before.length)

        holdResolve?.()
        await run

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("rejects /shell during manual /summarize", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const response = await app.request(`/session/${session.id}/shell`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "dummy", modelID: "dummy" },
            command: "echo ok",
          }),
        })

        expect(response.status).toBe(409)

        holdResolve?.()
        await run

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("force abort clears manual summarize state and prevents late CPD writes", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSetSpy = spyOn(SessionCPD, "set")

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          startedResolve?.()

          // Return only after we see abort.
          await new Promise<void>((resolve) => {
            const signal = input?.abort as AbortSignal | undefined
            if (!signal) {
              resolve()
              return
            }
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
          })

          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const abort = await app.request(`/session/${session.id}/abort?force=true`, {
          method: "POST",
          headers: { "x-opencode-directory": projectRoot },
        })
        expect(abort.status).toBe(200)
        expect(SessionCompaction.manual(session.id)).toBeUndefined()

        const afterAbort = await app.request(`/session/${session.id}/message`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "dummy", modelID: "dummy" },
            noReply: true,
            parts: [{ type: "text", text: "ok" }],
          }),
        })
        expect(afterAbort.status).toBe(200)

        await run
        expect(cpdSetSpy).toHaveBeenCalledTimes(0)

        cpdSpy.mockRestore()
        cpdSetSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("abort?force=false prevents late CPD writes even if provider returns after abort", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSetSpy = spyOn(SessionCPD, "set")
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const abort = await app.request(`/session/${session.id}/abort?force=false`, {
          method: "POST",
          headers: { "x-opencode-directory": projectRoot },
        })
        expect(abort.status).toBe(200)
        expect(SessionCompaction.manual(session.id)).toBeDefined()

        holdResolve?.()
        await run
        expect(cpdSetSpy).toHaveBeenCalledTimes(0)

        cpdSpy.mockRestore()
        cpdSetSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("abort?force=false does not force-clear manual summarize state", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started

        const abort = await app.request(`/session/${session.id}/abort?force=false`, {
          method: "POST",
          headers: { "x-opencode-directory": projectRoot },
        })
        expect(abort.status).toBe(200)
        expect(SessionCompaction.manual(session.id)).toBeDefined()

        holdResolve?.()
        await run

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("does not wake the prompt loop during /summarize (wakes after it ends)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          startedResolve?.()
          await hold
          return { text: "cpd", rctx: false }
        })

        const loopSpy = spyOn(SessionPrompt as any, "loop").mockImplementation(async () => {})

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started
        await SessionMessage.deliver({
          from: "ses_sender",
          to: session.id,
          text: "hello while compacting",
        })

        // Give the wake hook a chance to run.
        await Bun.sleep(25)

        // The delivered-message wake logic must not start a concurrent prompt loop while
        // manual compaction is in-flight.
        expect(loopSpy).toHaveBeenCalledTimes(0)

        holdResolve?.()
        await run

        // After /summarize ends, pending delivered messages should be processed.
        expect(loopSpy).toHaveBeenCalledTimes(1)

        cpdSpy.mockRestore()
        loopSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("session.abort cancels an in-flight /summarize and clears marker", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          startedResolve?.()
          await new Promise<void>((resolve, reject) => {
            input.abort?.addEventListener(
              "abort",
              () => {
                const err = Object.assign(new Error("aborted"), { name: "AbortError" })
                reject(err)
              },
              { once: true },
            )
          })
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started
        expect(SessionStatus.get(session.id).type).toBe("busy")
        expect(await SessionCompaction.marker(session.id)).toBeDefined()

        const abort = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": projectRoot },
        })
        expect(abort.status).toBe(200)

        const response = await run
        expect(response.status).toBe(200)

        expect(SessionStatus.get(session.id).type).toBe("idle")
        expect(await SessionCompaction.marker(session.id)).toBeUndefined()
        expect((await Session.get(session.id)).time.compacting).toBeUndefined()

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("/summarize does not set idle while manual compaction is still active", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          return { text: "cpd", rctx: false }
        })

        const app = Server.App()
        const session = await Session.create({})

        const originalSet = SessionStatus.set
        const setSpy = spyOn(SessionStatus, "set").mockImplementation((id: string, status: any) => {
          if (id === session.id && status?.type === "idle") {
            if (SessionCompaction.manual(session.id)) {
              throw new Error("set idle while manual compaction still active")
            }
          }
          return originalSet(id, status)
        })

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

        const response = await app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        expect(response.status).toBe(200)

        cpdSpy.mockRestore()
        setSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })

  test("session.abort does not set idle until /summarize unwinds", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let holdResolve: (() => void) | undefined
        const hold = new Promise<void>((resolve) => {
          holdResolve = resolve
        })

        let startedResolve: (() => void) | undefined
        const started = new Promise<void>((resolve) => {
          startedResolve = resolve
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          startedResolve?.()
          let aborted = false
          input.abort?.addEventListener(
            "abort",
            () => {
              aborted = true
            },
            { once: true },
          )
          await hold
          if (aborted) {
            const err = Object.assign(new Error("aborted"), { name: "AbortError" })
            throw err
          }
          return { text: "cpd", rctx: false }
        })

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

        const run = app.request(`/session/${session.id}/summarize`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencode-directory": projectRoot },
          body: JSON.stringify({ providerID: "dummy", modelID: "dummy" }),
        })

        await started
        expect(SessionStatus.get(session.id).type).toBe("busy")

        const abort = await app.request(`/session/${session.id}/abort`, {
          method: "POST",
          headers: { "x-opencode-directory": projectRoot },
        })
        expect(abort.status).toBe(200)

        // /abort must not temporarily reopen the session (idle) while summarize is still in-flight.
        expect(SessionStatus.get(session.id).type).toBe("busy")

        holdResolve?.()
        const response = await run
        expect(response.status).toBe(200)

        expect(SessionStatus.get(session.id).type).toBe("idle")

        cpdSpy.mockRestore()
        await Session.remove(session.id)
      },
    })
  })
})
