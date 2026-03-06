import { afterEach, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

test("prompt noReply persists user service tier", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const agents = await Agent.list()
      const primary = agents.find((a) => a.mode !== "subagent" && !a.hidden)
      if (!primary) throw new Error("no primary agent available")

      const msg = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: primary.name,
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "hello" }],
        noReply: true,
        serviceTier: "priority",
      })

      expect(msg.info.role).toBe("user")
      if (msg.info.role !== "user") throw new Error("expected user message")
      expect(msg.info.serviceTier).toBe("priority")
    },
  })
})

test("command persists user service tier", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const commandDir = path.join(dir, ".opencode", "command")
      await fs.mkdir(commandDir, { recursive: true })
      await Bun.write(
        path.join(commandDir, "hello.md"),
        `---
description: Test command
---
Hello from command`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id).catch(() => {})
        },
      }

      const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
        id: "dummy/dummy",
        providerID: "dummy",
        modelID: "dummy",
        api: {
          id: "dummy",
          url: "",
          npm: "@ai-sdk/openai",
        },
        limit: { context: 8192, output: 2048 },
      } as any)
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
            const message = args.assistantMessage
            message.finish = "end_turn"
            message.time.completed = Date.now()
            await Session.updateMessage(message)
            return "stop"
          },
        } as any
      })

      await using _restore = {
        [Symbol.asyncDispose]: async () => {
          modelSpy.mockRestore()
          processorSpy.mockRestore()
        },
      }

      await SessionPrompt.command({
        sessionID: session.id,
        command: "hello",
        arguments: "",
        agent: "build",
        model: "dummy/dummy",
        serviceTier: "priority",
      })

      const messages = await Session.messages({ sessionID: session.id })
      const user = messages.findLast((msg) => msg.info.role === "user")

      expect(user?.info.role).toBe("user")
      if (user?.info.role !== "user") throw new Error("expected user message")
      expect(user.info.serviceTier).toBe("priority")
    },
  })
})
