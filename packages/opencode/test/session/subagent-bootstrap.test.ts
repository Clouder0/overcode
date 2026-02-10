import { describe, expect, it, spyOn } from "bun:test"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { Provider } from "@/provider/provider"
import { SessionProcessor } from "@/session/processor"
import { ToolRegistry } from "@/tool/registry"
import { defer } from "@/util/defer"

describe("subagent bootstrap", () => {
  it("does not crash on synthetic bootstrap prompt", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const allow = new Set<string>()
        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = allow
        using _global = defer(() => {
          g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
        })

        const defaultSpy = spyOn(Provider, "defaultModel").mockResolvedValue({
          providerID: "openai",
          modelID: "gpt-test",
        })

        const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "gpt-test",
          providerID: "openai",
          info: {
            name: "test",
          },
          api: {
            id: "gpt-test",
          },
          cost: {
            input: 0,
            output: 0,
          },
          limit: {
            context: 8192,
            input: 8192,
            output: 4096,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "",
        } as any)

        const toolsSpy = spyOn(ToolRegistry, "tools").mockResolvedValue([])

        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process() {
              return "stop"
            },
          } as any
        })

        using _mocks = defer(() => {
          defaultSpy.mockRestore()
          modelSpy.mockRestore()
          toolsSpy.mockRestore()
          processorSpy.mockRestore()
        })

        const parent = await Session.createNext({
          directory: tmp.path,
          title: "parent",
          sessionType: "primary",
        })

        const child = await Session.createNext({
          directory: tmp.path,
          title: "child",
          parentID: parent.id,
          sessionType: "subagent",
          agentName: "general",
          subagentPrompt: "Echo back the word ping.",
        })

        allow.add(child.id)

        const result = await SessionPrompt.loop(child.id)
        expect(result.info.role).toBe("assistant")

        const msgs = await Session.messages({ sessionID: child.id })
        const user = msgs.find((m) => m.info.role === "user")
        expect(user).toBeTruthy()
        const text = user!.parts.find((p) => p.type === "text") as any
        expect(text.synthetic).toBe(true)
        expect(text.metadata?.opencode?.bootstrap).toBe(true)
      },
    })
  })
})
