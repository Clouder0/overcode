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
import { PermissionNext } from "../../src/permission/next"
import path from "path"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt context_length retry cleanup", () => {
  test("drops empty attempt messages after successful maintenance", async () => {
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

        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })

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

        // Mark user1 answered so user2 is the FIFO pending target.
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
          type: "text",
          text: "done",
        })

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

        let attemptID: string | undefined
        let created = 0
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          created++

          if (created === 1) {
            attemptID = args.assistantMessage.id
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

        expect(attemptID).toBeDefined()

        const messages = await Session.messages({ sessionID: session.id })
        const found = messages.some((m) => m.info.role === "assistant" && m.info.id === attemptID)
        expect(found).toBe(false)
      },
    })
  })

  test("reuses prior same-turn skill load across context-length retry attempts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(
          path.join(dir, ".opencode", "skill", "brainstorming", "SKILL.md"),
          `---
name: brainstorming
description: Brainstorm skill
---

# Brainstorming

Step one.
`,
        )
      },
    })

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

        const cpdSpy = spyOn(SessionCPD, "update").mockResolvedValue({ text: "cpd", rctx: false })
        const permissionSpy = spyOn(PermissionNext, "ask").mockResolvedValue(undefined as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            cpdSpy.mockRestore()
            permissionSpy.mockRestore()
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
          type: "text",
          text: "done",
        })

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

        const calls = { count: 0 }
        const skill = {
          first: undefined as Record<string, unknown> | undefined,
          second: undefined as Record<string, unknown> | undefined,
        }

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((input: any) => {
          const assistant = input.assistantMessage

          const processor: any = {
            message: assistant,
            compactionRequest: undefined,
            waitSince() {
              return 0
            },
            partFromToolCall() {
              return undefined
            },
            async process(args: any) {
              calls.count += 1
              const callID = `call-skill-${calls.count}`
              const out = await args.tools.skill.execute(
                { name: "brainstorming" },
                {
                  toolCallId: callID,
                  abortSignal: new AbortController().signal,
                },
              )

              if (calls.count === 1) skill.first = out.metadata as Record<string, unknown>
              if (calls.count === 2) skill.second = out.metadata as Record<string, unknown>

              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "tool",
                tool: "skill",
                callID,
                state: {
                  status: "completed",
                  input: { name: "brainstorming" },
                  output: out.output,
                  title: out.title,
                  metadata: out.metadata,
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              } as any)

              if (calls.count === 1) {
                processor.compactionRequest = {
                  reason: "context_length",
                  fallbackError: new NamedError.Unknown({
                    message: "This model's maximum context length is 1000 tokens, however you requested 1200 tokens.",
                  }).toObject(),
                }
                assistant.finish = "tool-calls"
                assistant.time.completed = Date.now()
                await Session.updateMessage(assistant)
                return "compact" as const
              }

              assistant.finish = "end_turn"
              assistant.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: session.id,
                messageID: assistant.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(assistant)
              return "continue" as const
            },
          }

          return processor
        })

        await SessionPrompt.loop(session.id)

        processorSpy.mockRestore()

        expect(calls.count).toBeGreaterThanOrEqual(2)
        expect(skill.first?.applied).toBe(true)
        expect(skill.second?.applied).toBe(false)
        expect(skill.second?.reason).toBe("same_turn")
      },
    })
  })
})
