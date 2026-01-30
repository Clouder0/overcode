import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionCompaction } from "../../src/session/compaction"
import { Config } from "../../src/config/config"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.compaction prune markers", () => {
  test("writes a trim marker when prune compacts tool outputs", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { prune: true },
        } as any)

        const session = await Session.create({})
        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            await Session.remove(session.id)
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
          sessionID: session.id,
          messageID: user1.id,
          type: "text",
          text: "u1",
        })

        const assistant1 = await Session.updateMessage({
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
          time: { created: now + 1, completed: now + 1 },
          finish: "end_turn",
        } as any)

        // Ensure we exceed PRUNE_PROTECT (40k tokens) so prune actually trims.
        // Token.estimate() is length/4, so 200_000 chars ~= 50_000 tokens.
        const output = "x".repeat(200_000)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: assistant1.id,
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo 1" },
            output,
            title: "bash",
            metadata: {},
            time: { start: now, end: now },
          },
        } as any)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: assistant1.id,
          type: "tool",
          callID: "call-2",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo 2" },
            output,
            title: "bash",
            metadata: {},
            time: { start: now, end: now },
          },
        } as any)

        // Create at least two newer user turns so prune will consider older tool outputs.
        const user2 = await Session.updateMessage({
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
          messageID: user2.id,
          type: "text",
          text: "u2",
        })

        const user3 = await Session.updateMessage({
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
          messageID: user3.id,
          type: "text",
          text: "u3",
        })

        await SessionCompaction.prune({ sessionID: session.id })

        const info = await Session.get(session.id)
        expect(info.context?.trim).toBe(true)

        const msgs = await Session.messages({ sessionID: session.id })
        const marker = msgs
          .flatMap((m) => m.parts)
          .find((p) => {
            if (p.type !== "text") return false
            if (p.ignored !== true) return false
            const meta = p.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          })

        expect(marker).toBeDefined()

        const meta = (marker as any).metadata.opencode.marker
        expect(meta.count).toBeGreaterThan(0)
        expect(meta.tokens).toBeGreaterThan(0)
      },
    })
  })
})
