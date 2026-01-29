import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionPrompt } from "../../src/session/prompt"
import { Provider } from "../../src/provider/provider"
import { SessionProcessor } from "../../src/session/processor"
import { SessionCPD } from "../../src/session/cpd"
import { Config } from "../../src/config/config"
import { NamedError } from "@opencode-ai/util/error"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt CPD delta tool output", () => {
  test("includes an excerpt of compacted tool output (not placeholder)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({
          compaction: { auto: "allow" },
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
          limit: { context: 8192, output: 2048 },
        } as any)

        let capturedDelta: string | undefined
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          capturedDelta = input?.delta
          return { text: "cpd", rctx: false }
        })

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            cpdSpy.mockRestore()
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
          sessionID: session.id,
          messageID: user1.id,
          type: "text",
          text: "prefix",
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

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: assistant1.id,
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            output: "TOOL_OUTPUT_START\nhello\n",
            title: "bash",
            metadata: {},
            time: { start: now, end: now, compacted: now },
          },
        } as any)

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
          text: "trigger",
        })

        let created = 0
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          created++
          if (created === 1) {
            return {
              message: args.assistantMessage,
              compactionRequest: {
                reason: "context_length",
                fallbackError: new NamedError.Unknown({
                  message: "This model's maximum context length is 1000 tokens, however you requested 1200 tokens.",
                }).toObject(),
              },
              waitSince() {
                return 0
              },
              partFromToolCall() {
                return undefined
              },
              async process() {
                return "compact" as const
              },
            } as any
          }

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
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "continue" as const
            },
          } as any
        })

        await SessionPrompt.loop(session.id)

        processorSpy.mockRestore()

        expect(capturedDelta).toBeDefined()
        expect(capturedDelta).toContain("TOOL_OUTPUT_START")
        expect(capturedDelta).not.toContain("[Old tool result content cleared]")
        expect(capturedDelta).toContain("[Tool output trimmed in continuation prompt]")
      },
    })
  })
})
