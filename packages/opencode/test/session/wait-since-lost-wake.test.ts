import { afterEach, expect, mock, spyOn, test } from "bun:test"
import z from "zod"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { Plugin } from "../../src/plugin"
import { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

function monoNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

type Seeded = {
  sessionID: string
  sourceID: string
  waitMessageID: string
  callID: string
}

async function seed(root: string): Promise<Seeded> {
  const session = await Session.create({})
  const source = await Session.create({})

  const now = Date.now()
  const timeout = 250
  const callID = "call_wait"

  const userMessageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: userMessageID,
    sessionID: session.id,
    role: "user",
    time: { created: now },
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-4",
    },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: userMessageID,
    type: "text",
    text: "seed",
  })

  const waitMessageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: waitMessageID,
    sessionID: session.id,
    role: "assistant",
    time: {
      created: now,
      completed: now,
    },
    parentID: userMessageID,
    modelID: "gpt-4",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: {
      cwd: root,
      root,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    finish: "tool-calls",
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: session.id,
    messageID: waitMessageID,
    type: "tool",
    callID,
    tool: "wait_agent_message",
    state: {
      status: "completed",
      input: {
        sources: [source.id],
        timeout,
        mode: "all",
        since: 0,
      },
      output: "Wait registered. End your turn now.",
      title: "Wait registered",
      metadata: {},
      time: {
        start: now,
        end: now,
      },
    },
  })

  const sentinelID = Identifier.ascending("message")
  await Session.updateMessage({
    id: sentinelID,
    sessionID: session.id,
    role: "assistant",
    time: {
      created: now,
      completed: now,
    },
    parentID: userMessageID,
    modelID: "gpt-4",
    providerID: "openai",
    mode: "build",
    agent: "build",
    path: {
      cwd: root,
      root,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    finish: "stop",
  })

  return {
    sessionID: session.id,
    sourceID: source.id,
    waitMessageID,
    callID,
  }
}

test("wait resolves even if message arrived and pending was drained before wait registration", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        // After wait resolution, the loop continues and processes the seed message.
        // Mock provider and processor so it completes cleanly.
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
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        try {
          const since = SessionMessage.nowSeq(seeded.sessionID)

          await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "early reply",
          })

          // Simulate the core failure mode: message got drained from pending before wait is registered.
          SessionMessage.takePending(seeded.sessionID, () => true)

          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 250,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 250,
            mode: "all",
            time: policy.time,
          })

          await SessionPrompt.loop(seeded.sessionID)

          const start = monoNow()
          while (monoNow() - start < 2000) {
            if (WaitPolicy.isWaiting(seeded.sessionID)) {
              await Bun.sleep(5)
              continue
            }

            const parts = await MessageV2.parts(seeded.waitMessageID)
            const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
            if (tool?.type !== "tool") {
              await Bun.sleep(5)
              continue
            }

            const meta = tool.state.status === "completed" ? tool.state.metadata : undefined
            if (meta && meta.status === "resolved") {
              expect(meta.respondedSources).toEqual([seeded.sourceID])
              return
            }

            await Bun.sleep(5)
          }

          expect(WaitPolicy.isWaiting(seeded.sessionID)).toBe(false)
          const parts = await MessageV2.parts(seeded.waitMessageID)
          const tool = parts.find((p): p is MessageV2.ToolPart => p.type === "tool" && p.callID === seeded.callID)
          expect(tool?.type).toBe("tool")
          if (tool?.type !== "tool") return
          expect(tool.state.status).toBe("completed")
          if (tool.state.status !== "completed") return
          expect(tool.state.metadata.status).toBe("resolved")
          expect(tool.state.metadata.respondedSources).toEqual([seeded.sourceID])
          expect(tool.state.output).toContain("Wait resolved")
          expect(tool.state.output).toContain("responded:")
        } finally {
          providerSpy.mockRestore()
          processorSpy.mockRestore()
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})

test("wait resume includes responded message content in immediate model context", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        const existing = await Session.messages({ sessionID: seeded.sessionID })
        const sentinel = existing.find(
          (msg) => msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish === "stop",
        )
        if (sentinel) {
          await Session.removeMessage({ sessionID: seeded.sessionID, messageID: sentinel.info.id })
        }

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

        let captured = ""
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
              captured = JSON.stringify(input.messages)
              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: seeded.sessionID,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        try {
          const since = SessionMessage.nowSeq(seeded.sessionID)
          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
            time: policy.time,
          })

          await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "reply data",
          })

          await SessionPrompt.loop(seeded.sessionID)

          for (let i = 0; i < 400; i++) {
            if (captured.length > 0) break
            await Bun.sleep(10)
          }

          expect(captured).toContain("reply data")
          expect(captured).toContain(seeded.sourceID)
        } finally {
          providerSpy.mockRestore()
          processorSpy.mockRestore()
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})

test("wait resume consumes queued inbound replies as one scheduling turn", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        const existing = await Session.messages({ sessionID: seeded.sessionID })
        const sentinel = existing.find(
          (msg) => msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish === "stop",
        )
        if (sentinel) {
          await Session.removeMessage({ sessionID: seeded.sessionID, messageID: sentinel.info.id })
        }

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

        const parents: string[] = []
        const payloads: string[] = []
        const triggerSpy = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
          if (name === "experimental.chat.messages.transform") {
            const val = output as { messages?: unknown }
            if (Array.isArray(val.messages)) {
              val.messages.reverse()
            }
          }
          return output
        })
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
              parents.push(args.assistantMessage.parentID)
              payloads.push(JSON.stringify(input.messages))

              args.assistantMessage.finish = "end_turn"
              args.assistantMessage.time.completed = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: seeded.sessionID,
                messageID: args.assistantMessage.id,
                type: "text",
                text: "ok",
              })
              await Session.updateMessage(args.assistantMessage)
              return "continue" as const
            },
          } as any
        })

        try {
          const since = SessionMessage.nowSeq(seeded.sessionID)
          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
            time: policy.time,
          })

          const first = await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "reply one",
          })

          const second = await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "reply two",
          })

          await SessionPrompt.loop(seeded.sessionID)

          // The loop processes the queued replies in one batched turn, then continues
          // to process the original (previously-parked) seed message in a second turn.
          expect(parents.length).toBe(2)
          // Both replies are in the first turn's context.
          expect(payloads[0] ?? "").toContain("reply one")
          expect(payloads[0] ?? "").toContain("reply two")
          const one = (payloads[0] ?? "").indexOf("reply one")
          const two = (payloads[0] ?? "").indexOf("reply two")
          expect(one).toBeGreaterThan(-1)
          expect(two).toBeGreaterThan(-1)
          expect(one < two).toBe(true)

          const firstParts = await MessageV2.parts(first.id)
          const firstMsg = firstParts.find((part): part is MessageV2.MessagePart => part.type === "message")
          expect((firstMsg?.metadata as any)?.opencode?.consumed).toBe(true)

          const secondParts = await MessageV2.parts(second.id)
          const secondMsg = secondParts.find((part): part is MessageV2.MessagePart => part.type === "message")
          expect((secondMsg?.metadata as any)?.opencode?.consumed).toBe(true)
        } finally {
          providerSpy.mockRestore()
          processorSpy.mockRestore()
          triggerSpy.mockRestore()
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})

test("wait resume consumes replies after non-terminal tool-calls turn", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        const existing = await Session.messages({ sessionID: seeded.sessionID })
        const sentinel = existing.find(
          (msg) => msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish === "stop",
        )
        if (sentinel) {
          await Session.removeMessage({ sessionID: seeded.sessionID, messageID: sentinel.info.id })
        }

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

        const payloads: string[] = []
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
              payloads.push(JSON.stringify(input.messages))

              const now = Date.now()
              await Session.updatePart({
                id: Identifier.ascending("part"),
                sessionID: seeded.sessionID,
                messageID: args.assistantMessage.id,
                type: "tool",
                callID: "call_nonterminal",
                tool: "send_agent_message",
                state: {
                  status: "completed",
                  input: {
                    to: seeded.sourceID,
                    text: "ack",
                  },
                  output: "ack sent",
                  title: "sent",
                  metadata: {},
                  time: {
                    start: now,
                    end: now,
                  },
                },
              })

              args.assistantMessage.finish = "tool-calls"
              args.assistantMessage.time.completed = now
              await Session.updateMessage(args.assistantMessage)
              return "stop" as const
            },
          } as any
        })

        try {
          const since = SessionMessage.nowSeq(seeded.sessionID)
          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
            time: policy.time,
          })

          const reply = await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "stop now",
          })

          await SessionPrompt.loop(seeded.sessionID)

          expect(payloads[0] ?? "").toContain("stop now")

          const parts = await MessageV2.parts(reply.id)
          const msg = parts.find((part): part is MessageV2.MessagePart => part.type === "message")
          expect((msg?.metadata as any)?.opencode?.consumed).toBe(true)
        } finally {
          providerSpy.mockRestore()
          processorSpy.mockRestore()
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})

test("wait resume rebuilds waitContext with the latest inbound seq", async () => {
  const g = globalThis as any
  const originalAllow = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seeded = await seed(tmp.path)
        allow.add(seeded.sessionID)

        const existing = await Session.messages({ sessionID: seeded.sessionID })
        const sentinel = existing.find(
          (msg) => msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish === "stop",
        )
        if (sentinel) {
          await Session.removeMessage({ sessionID: seeded.sessionID, messageID: sentinel.info.id })
        }

        const seen: Array<{ seq: number | undefined; messages: string }> = []

        SessionPrompt.setExtraTools(seeded.sessionID, [
          Tool.define("probe", {
            description: "Inspect wait context after resume",
            parameters: z.object({}),
            async execute(_args, ctx) {
              seen.push({
                seq: ctx.extra?.waitContext?.maxSeqBySource[seeded.sourceID],
                messages: JSON.stringify(ctx.messages),
              })

              return {
                title: "probe",
                metadata: {},
                output: "probe",
              }
            },
          }),
        ])

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

        const llmSpy = spyOn(LLM, "stream").mockImplementation(async (input) => {
          async function* fullStream() {
            yield { type: "start" as const }
            yield { type: "tool-input-start" as const, id: "call_probe", toolName: "probe" }
            yield {
              type: "tool-call" as const,
              toolCallId: "call_probe",
              toolName: "probe",
              input: {},
            }

            const probe = input.tools.probe
            expect(probe).toBeDefined()
            if (!probe) throw new Error("missing probe tool")
            const execute = probe.execute
            expect(execute).toBeDefined()
            if (!execute) throw new Error("missing probe execute")

            yield {
              type: "tool-result" as const,
              toolCallId: "call_probe",
              toolName: "probe",
              input: {},
              output: await execute({}, { toolCallId: "call_probe" } as any),
            }
            yield {
              type: "finish-step" as const,
              finishReason: "stop",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
            }
            yield { type: "finish" as const }
          }

          return { fullStream: fullStream() } as any
        })

        try {
          const since = SessionMessage.nowSeq(seeded.sessionID)
          const policy = WaitPolicy.register({
            sessionID: seeded.sessionID,
            messageID: seeded.waitMessageID,
            callID: seeded.callID,
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
          })

          SessionStatus.set(seeded.sessionID, {
            type: "waiting",
            sources: [seeded.sourceID],
            timeout: 500,
            mode: "all",
            since,
            time: policy.time,
          })

          const reply = await SessionMessage.deliver({
            from: seeded.sourceID,
            to: seeded.sessionID,
            text: "reply data",
            awaitWake: true,
          })

          await SessionPrompt.loop(seeded.sessionID)

          const item = seen[0]
          expect(item).toBeDefined()
          if (!item) return

          expect(item.seq).toBe(reply.seq)
          expect(item.messages).toContain("reply data")
        } finally {
          SessionPrompt.clearExtraTools(seeded.sessionID)
          llmSpy.mockRestore()
          providerSpy.mockRestore()
          WaitPolicy.clear(seeded.sessionID)
          WaitPolicy.clear(seeded.sourceID)
          await Session.remove(seeded.sourceID)
          await Session.remove(seeded.sessionID)
        }
      },
    })
  } finally {
    if (originalAllow === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }
    if (originalAllow !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = originalAllow
    }
  }
})
