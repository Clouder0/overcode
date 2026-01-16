import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("subagent loop continues after send_agent_message", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.createNext({
          directory: tmp.path,
          sessionType: "subagent",
          parentID: parent.id,
          agentName: "general",
          title: "Subagent - general",
        })

        allow.add(child.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(child.id)
            await Session.remove(parent.id)
          },
        }

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai",
          },
          name: "dummy",
          capabilities: {
            temperature: true,
            reasoning: true,
            attachment: true,
            toolcall: true,
            input: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            output: {
              text: true,
              audio: false,
              image: false,
              video: false,
              pdf: false,
            },
            interleaved: false,
          },
          cost: {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          },
          limit: {
            context: 8192,
            output: 4096,
          },
          status: "active",
          options: {},
          headers: {},
          release_date: "",
        } as any)

        const calls = { count: 0 }
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            waitSince: () => undefined,
            async process(input: any) {
              calls.count += 1

              const tools = (input?.tools ?? {}) as Record<
                string,
                { execute: (args: any, options: any) => Promise<any> }
              >
              const send = tools.send_agent_message

              if (calls.count === 1) {
                await send.execute(
                  {
                    to: parent.id,
                    text: "ping",
                  },
                  {
                    toolCallId: "call_send_1",
                  },
                )

                return "continue"
              }

              return "stop"
            },
          } as any
        })

        const userID = Identifier.ascending("message")
        const now = Date.now()

        await Session.updateMessage({
          id: userID,
          sessionID: child.id,
          role: "user",
          time: { created: now },
          agent: "general",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: child.id,
          messageID: userID,
          type: "text",
          text: "seed",
        })

        const originalTools = ToolRegistry.tools
        const registrySpy = spyOn(ToolRegistry, "tools").mockImplementation(async (providerID: string, agent: any) => {
          const base = await originalTools(providerID, agent)
          const wanted = new Set(["send_agent_message"])
          return base.filter((t) => wanted.has(t.id))
        })

        await SessionPrompt.loop(child.id)

        expect(calls.count).toBe(2)

        registrySpy.mockRestore()
        processorSpy.mockRestore()
        providerSpy.mockRestore()
        summarySpy.mockRestore()

        const history = await MessageV2.filterCompacted(MessageV2.stream(child.id))
        const msgParts = history
          .filter((m) => m.info.role === "assistant")
          .flatMap((m) => m.parts)
          .filter((p): p is MessageV2.MessagePart => p.type === "message")

        expect(msgParts.some((p) => p.direction === "outgoing" && p.peer === parent.id)).toBe(true)
      },
    })
  } finally {
    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})
