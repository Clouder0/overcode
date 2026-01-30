import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionRevert } from "../../src/session/revert"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.revert flag reconciliation", () => {
  test("cleanup keeps rctx when omitted reasoning remains but marker is reverted away", async () => {
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
        } as any)

        // Simulate provider-rejected reasoning context that left older reasoning omitted.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a1.id,
          type: "reasoning",
          text: "hidden reasoning",
          ignored: true,
          time: { start: now + 1, end: now + 1 },
          metadata: {
            opencode: {
              status: "omitted",
              reason: "provider_rejected_reasoning_context",
              at: now + 1,
            },
          },
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

        const a2 = await Session.updateMessage({
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

        // Marker will be removed by revert cleanup.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a2.id,
          type: "text",
          text: "rctx marker",
          synthetic: true,
          ignored: true,
          time: { start: now + 3, end: now + 3 },
          metadata: {
            opencode: {
              marker: {
                kind: "rctx",
                at: now + 3,
              },
            },
          },
        } as any)

        await SessionRevert.revert({ sessionID: session.id, messageID: u2.id })
        const info = await Session.get(session.id)
        await SessionRevert.cleanup(info)

        const after = await Session.get(session.id)
        expect(after.context?.rctx).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("cleanup keeps think when context-limit omitted reasoning remains but marker is reverted away", async () => {
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
        } as any)

        // Simulate context-limit omission that left older reasoning omitted.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a1.id,
          type: "reasoning",
          text: "hidden reasoning",
          ignored: true,
          time: { start: now + 1, end: now + 1 },
          metadata: {
            opencode: {
              status: "omitted",
              reason: "context_limit",
              at: now + 1,
            },
          },
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

        const a2 = await Session.updateMessage({
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

        // Marker will be removed by revert cleanup.
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: a2.id,
          type: "text",
          text: "think marker",
          synthetic: true,
          ignored: true,
          time: { start: now + 3, end: now + 3 },
          metadata: {
            opencode: {
              marker: {
                kind: "think",
                at: now + 3,
              },
            },
          },
        } as any)

        await SessionRevert.revert({ sessionID: session.id, messageID: u2.id })
        const info = await Session.get(session.id)
        await SessionRevert.cleanup(info)

        const after = await Session.get(session.id)
        expect(after.context?.think).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})
