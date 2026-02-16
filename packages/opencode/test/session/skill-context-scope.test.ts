import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { PermissionNext } from "../../src/permission/next"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionCPD } from "../../src/session/cpd"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SkillTool } from "../../src/tool/skill"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.prompt skill dedup context scope", () => {
  test("applies skill when prior load is outside scoped prompt context", async () => {
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

        const permissionSpy = spyOn(PermissionNext, "ask").mockResolvedValue(undefined as any)

        const session = await Session.create({})
        const agent = await Agent.get("build")
        const skill = await SkillTool.init({ agent })

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            permissionSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const priorLoad = await skill.execute({ name: "brainstorming" }, {
          sessionID: session.id,
          messageID: "seed-message",
          agent: agent.name,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
          messages: [],
        } as any)

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
          callID: "call-prior",
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "brainstorming" },
            output: priorLoad.output,
            title: priorLoad.title,
            metadata: priorLoad.metadata,
            time: {
              start: now + 1,
              end: now + 1,
            },
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

        await SessionCPD.set(session.id, {
          text: "cpd",
          upto: user1.id,
          updated: now + 3,
        })

        const seen = {
          applied: undefined as unknown,
          reason: undefined as unknown,
        }

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
            async process(input: any) {
              const out = await input.tools.skill.execute(
                { name: "brainstorming" },
                {
                  toolCallId: "call-current",
                  abortSignal: new AbortController().signal,
                },
              )

              const meta = out.metadata as { applied?: unknown; reason?: unknown }
              seen.applied = meta.applied
              seen.reason = meta.reason

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

        expect(seen.applied).toBe(true)
        expect(seen.reason).toBe("applied")
      },
    })
  })

  test("applies skill when transform removes prior load from scoped context", async () => {
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

        const permissionSpy = spyOn(PermissionNext, "ask").mockResolvedValue(undefined as any)

        const session = await Session.create({})
        const agent = await Agent.get("build")
        const skill = await SkillTool.init({ agent })

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            permissionSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const priorLoad = await skill.execute({ name: "brainstorming" }, {
          sessionID: session.id,
          messageID: "seed-message",
          agent: agent.name,
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
          messages: [],
        } as any)

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
          callID: "call-prior",
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "brainstorming" },
            output: priorLoad.output,
            title: priorLoad.title,
            metadata: priorLoad.metadata,
            time: {
              start: now + 1,
              end: now + 1,
            },
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

        const hiddenID = assistant1.id
        const transformSpy = spyOn(Plugin, "trigger").mockImplementation(async (name: string, _input, output) => {
          if (name === "experimental.chat.messages.transform") {
            const val = output as { messages?: unknown }
            if (Array.isArray(val.messages)) {
              for (let i = val.messages.length - 1; i >= 0; i--) {
                if (val.messages[i]?.info?.id !== hiddenID) continue
                val.messages.splice(i, 1)
              }
            }
          }

          return output
        })

        const seen = {
          applied: undefined as unknown,
          reason: undefined as unknown,
        }

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
            async process(input: any) {
              const out = await input.tools.skill.execute(
                { name: "brainstorming" },
                {
                  toolCallId: "call-current",
                  abortSignal: new AbortController().signal,
                },
              )

              const meta = out.metadata as { applied?: unknown; reason?: unknown }
              seen.applied = meta.applied
              seen.reason = meta.reason

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
        transformSpy.mockRestore()

        expect(seen.applied).toBe(true)
        expect(seen.reason).toBe("applied")
      },
    })
  })
})
