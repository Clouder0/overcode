import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { SessionProcessor } from "../../src/session/processor"
import { Config } from "../../src/config/config"
import { SessionCPD } from "../../src/session/cpd"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt maintenance trim markers", () => {
  test("trim marker tokens reflect actual prompt delta", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 12_000, output: 1_000 },
        } as any)
        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)
        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process() {
              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            processorSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const seed = await Session.updateMessage({
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
          messageID: seed.id,
          type: "text",
          text: "seed",
        })

        const visible = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: session.id,
          parentID: seed.id,
          modelID: "dummy",
          providerID: "dummy",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + 1, completed: now + 1 },
          finish: "stop",
        } as any)
        for (const i of [0, 1, 2]) {
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: visible.id,
            type: "tool",
            callID: `visible-call-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: "v".repeat(20_000),
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          } as any)
        }

        const pending = await Session.updateMessage({
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
          messageID: pending.id,
          type: "text",
          text: "run",
        })

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })

        const marker = msgs
          .flatMap((msg) => msg.parts)
          .find((part) => {
            if (part.type !== "text") return false
            if (part.ignored !== true) return false
            const meta = part.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          }) as MessageV2.TextPart | undefined

        expect(marker).toBeDefined()

        const tokens = (marker?.metadata as any)?.opencode?.marker?.tokens
        expect(typeof tokens).toBe("number")
        expect(tokens).toBeGreaterThan(0)

        const visibleMsg = msgs.find((m) => m.info.id === visible.id)
        expect(visibleMsg).toBeDefined()

        const trimmed = (visibleMsg?.parts.filter((p) => {
          if (p.type !== "tool") return false
          if (p.state.status !== "completed") return false
          return typeof p.state.time.compacted === "number"
        }) ?? []) as MessageV2.ToolPart[]

        const freedEstimate = trimmed.reduce((sum, part) => sum + MessageV2.toolOutputTokens(part), 0)
        expect(freedEstimate).toBeGreaterThan(0)

        // marker.tokens should reflect the actual prompt-size reduction, which is
        // slightly smaller than the raw sum of tool output estimates (placeholder overhead).
        expect(tokens).toBeLessThan(freedEstimate)
      },
    })
  })
})
