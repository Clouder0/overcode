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
import { NamedError } from "@opencode-ai/util/error"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt maintenance tool trimming", () => {
  test("only trims tool outputs from model-visible messages", async () => {
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

        const hiddenError = new NamedError.Unknown({ message: "hidden failure" }).toObject()
        const hidden = await Session.updateMessage({
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
          finish: "error",
          error: hiddenError,
        } as any)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: hidden.id,
          type: "tool",
          callID: "hidden-call",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hidden" },
            output: "h".repeat(400),
            title: "bash",
            metadata: {},
            time: { start: now + 1, end: now + 1 },
          },
        } as any)

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
          time: { created: now + 2, completed: now + 2 },
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
              time: { start: now + 2, end: now + 2 },
            },
          } as any)
        }

        const pending = await Session.updateMessage({
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
          messageID: pending.id,
          type: "text",
          text: "run",
        })

        const baseline = await Session.messages({ sessionID: session.id })
        const model = await Provider.getModel("dummy", "dummy")
        const outputReserve = Math.min(model.limit.output, 32_000) || 32_000
        const usable = model.limit.input || model.limit.context - outputReserve
        const budget = Math.max(0, Math.floor(usable * 0.9))
        const estimate = MessageV2.toModelMessages(baseline, model)
          .map((m) => {
            if (typeof m.content === "string") return m.content
            return JSON.stringify(m.content)
          })
          .reduce((sum, str) => sum + Token.estimate(str), 0)
        expect(estimate).toBeGreaterThan(budget)

        await SessionPrompt.loop(session.id)

        const msgs = await Session.messages({ sessionID: session.id })
        const hiddenMsg = msgs.find((m) => m.info.id === hidden.id)
        const visibleMsg = msgs.find((m) => m.info.id === visible.id)

        expect(hiddenMsg).toBeDefined()
        expect(visibleMsg).toBeDefined()

        const hiddenTool = hiddenMsg?.parts.find((p) => p.type === "tool") as MessageV2.ToolPart | undefined
        const visibleTools = (visibleMsg?.parts.filter((p) => p.type === "tool") ?? []) as MessageV2.ToolPart[]

        expect(hiddenTool).toBeDefined()
        expect(visibleTools.length).toBeGreaterThan(0)

        const hiddenCompacted = (() => {
          if (!hiddenTool) return undefined
          if (hiddenTool.state.status !== "completed") return undefined
          return hiddenTool.state.time.compacted
        })()

        expect(hiddenCompacted).toBeUndefined()
        expect(
          visibleTools.some((p) => {
            if (p.state.status !== "completed") return false
            return typeof p.state.time.compacted === "number"
          }),
        ).toBe(true)
      },
    })
  })
})
