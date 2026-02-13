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
import { Token } from "../../src/util/token"
import { SystemPrompt } from "../../src/session/system"
import { InstructionPrompt } from "../../src/session/instruction"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

const INTEGRITY = [
  "<context-integrity>",
  "Tool outputs may be trimmed to fit context.",
  "Use the Compacted Prefix Digest (CPD) + visible messages.",
  "If you need trimmed details, re-run tools or re-read files.",
  "</context-integrity>",
].join("\n")

function promptTokens(input: { messages: MessageV2.WithParts[]; model: any; system: string[] }) {
  const modelTokens = MessageV2.toModelMessages(input.messages, input.model)
    .map((m) => {
      if (typeof m.content === "string") return m.content
      return JSON.stringify(m.content)
    })
    .reduce((sum, str) => sum + Token.estimate(str), 0)

  const systemTokens = input.system.reduce((sum, str) => sum + Token.estimate(str), 0)
  return modelTokens + systemTokens
}

describe("session.prompt maintenance trim batching", () => {
  test("trims in one batch to avoid repeated micro-trims", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: true },
          experimental: { context_pipeline: true },
        } as any)

        // Keep system prompt overhead stable/small so the test can calibrate a
        // tight budget and reproduce micro-overage conditions.
        const envSpy = spyOn(SystemPrompt, "environment").mockResolvedValue([] as any)
        const protocolSpy = spyOn(SystemPrompt, "messageProtocol").mockReturnValue([] as any)
        const instructionSpy = spyOn(InstructionPrompt, "system").mockResolvedValue([] as any)

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

        const ref: { model?: any } = {}
        const providerSpy = spyOn(Provider, "getModel").mockImplementation(async () => {
          if (!ref.model) throw new Error("Model not configured")
          return ref.model
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            envSpy.mockRestore()
            protocolSpy.mockRestore()
            instructionSpy.mockRestore()
            summarySpy.mockRestore()
            cpdSpy.mockRestore()
            processorSpy.mockRestore()
            providerSpy.mockRestore()
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

        const toolsMsg = await Session.updateMessage({
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

        const toolOutput = "x".repeat(450)
        const toolIndexes = Array.from({ length: 6 }, (_, i) => i)
        const toolParts = [] as MessageV2.ToolPart[]
        for (const i of toolIndexes) {
          const part = (await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: toolsMsg.id,
            type: "tool",
            callID: `tool-${i}`,
            tool: "bash",
            state: {
              status: "completed",
              input: { command: `echo ${i}` },
              output: toolOutput,
              title: "bash",
              metadata: {},
              time: { start: now + 1, end: now + 1 },
            },
          })) as MessageV2.ToolPart
          toolParts.push(part)
        }

        const u1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: "dummy", modelID: "dummy" },
          variant: "v1",
          time: { created: now + 2 },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: u1.id,
          type: "text",
          text: "turn-1",
        })

        const uText = "u".repeat(600)

        const sampleTool = toolParts[0]
        expect(sampleTool).toBeDefined()
        const toolTokens = MessageV2.toolOutputTokens(sampleTool!)
        expect(toolTokens).toBeGreaterThan(0)

        const baseline = await Session.messages({ sessionID: session.id })
        const pivot = baseline.findIndex((m) => m.info.id === u1.id)
        expect(pivot).toBeGreaterThanOrEqual(0)
        const scoped = baseline.slice(0, pivot + 1)

        const outputReserve = 200
        const baseModel = {
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 10_000, output: outputReserve },
        } as any
        const estimate = promptTokens({ messages: scoped, model: baseModel, system: [INTEGRITY] })

        const desired = 70
        const minOver = 10
        const maxOver = Math.max(minOver, toolTokens - 1)
        const target = estimate - Math.min(desired, maxOver)
        const start = outputReserve + Math.ceil(target / 0.9)

        const deltas = Array.from({ length: 120 }, (_, i) => i).flatMap((i) => (i === 0 ? [0] : [-i, i]))
        const context = (() => {
          for (const d of deltas) {
            const candidate = start + d
            if (candidate <= outputReserve + 10) continue
            const usable = candidate - outputReserve
            const budget = Math.max(0, Math.floor(usable * 0.9))
            const over = estimate - budget
            if (over <= 0) continue
            if (over < minOver) continue
            if (over > maxOver) continue
            return candidate
          }
          throw new Error("Failed to calibrate model context for micro-trim batching")
        })()

        ref.model = {
          ...baseModel,
          limit: {
            context,
            output: outputReserve,
          },
        }

        const usable = context - outputReserve
        const budget = Math.max(0, Math.floor(usable * 0.9))
        const over = estimate - budget
        expect(over).toBeGreaterThan(0)
        expect(over).toBeLessThan(toolTokens)

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const trimMarkers = msgs
          .flatMap((m) => m.parts)
          .filter((part) => {
            if (part.type !== "text") return false
            if (part.ignored !== true) return false
            const meta = part.metadata as any
            return meta?.opencode?.marker?.kind === "trim"
          }) as MessageV2.TextPart[]

        expect(trimMarkers.length).toBe(1)

        const markerCount = (trimMarkers[0]?.metadata as any)?.opencode?.marker?.count
        expect(typeof markerCount).toBe("number")
        expect(markerCount).toBeGreaterThan(1)

        const updated = await Session.messages({ sessionID: session.id })
        const toolsAfter = updated.find((m) => m.info.id === toolsMsg.id)
        expect(toolsAfter).toBeDefined()

        const candidates = (toolsAfter?.parts.filter((p) => p.type === "tool") ?? []) as MessageV2.ToolPart[]
        expect(candidates.length).toBeGreaterThan(0)

        const compacted = candidates.filter((p) => {
          if (p.state.status !== "completed") return false
          return typeof p.state.time.compacted === "number"
        })

        expect(compacted.length).toBeGreaterThan(1)
        expect(compacted.length).toBeLessThan(candidates.length)

        const after = await Session.messages({ sessionID: session.id })
        const estimateAfterTrim = promptTokens({ messages: after, model: ref.model, system: [INTEGRITY] })
        const usableAfterTrim = ref.model.limit.context - outputReserve
        const budgetAfterTrim = Math.max(0, Math.floor(usableAfterTrim * 0.9))
        const slack = budgetAfterTrim - estimateAfterTrim

        // Ensure the trim created enough slack to absorb a future "normal" user
        // prompt without triggering a second micro-trim.
        expect(slack).toBeGreaterThan(Token.estimate(uText))
      },
    })
  })
})
