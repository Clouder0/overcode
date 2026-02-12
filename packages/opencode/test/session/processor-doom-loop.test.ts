import { expect, spyOn, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { PermissionNext } from "@/permission/next"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"

test("detects doom loop when repeated tool calls are separated by reasoning", async () => {
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

      const now = Date.now()
      const userID = Identifier.ascending("message")
      await Session.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: "seed",
      })

      const assistantID = Identifier.ascending("message")
      const assistant: MessageV2.Assistant = {
        id: assistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        modelID: "gpt-4",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now },
      }
      await Session.updateMessage(assistant)

      const model = { id: "test", providerID: "openai", limit: { context: 8192, output: 2048 } } as any
      const processor = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model,
        abort: new AbortController().signal,
      })

      const askSpy = spyOn(PermissionNext, "ask").mockResolvedValue(undefined)
      const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
        async function* fullStream() {
          yield { type: "start" }

          for (const n of [1, 2, 3]) {
            const callID = `call_skill_${n}`
            const reasonID = `reason_${n}`

            yield { type: "reasoning-start", id: reasonID }
            yield { type: "reasoning-delta", id: reasonID, text: "Thinking: Planning deeper systematic debugging" }
            yield { type: "reasoning-end", id: reasonID }

            yield { type: "tool-input-start", id: callID, toolName: "skill" }
            yield {
              type: "tool-call",
              toolCallId: callID,
              toolName: "skill",
              input: { name: "systematic-debugging" },
            }
            yield {
              type: "tool-result",
              toolCallId: callID,
              input: { name: "systematic-debugging" },
              output: {
                title: "Skill up-to-date: systematic-debugging",
                output: "Skill already active.",
                metadata: {
                  name: "systematic-debugging",
                  applied: false,
                  status: "noop",
                  reason: "duplicate_in_turn",
                },
                attachments: [],
              },
            }
          }

          yield { type: "finish" }
        }

        return { fullStream: fullStream() } as any
      })

      try {
        await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: (await Agent.get("build")) as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {
            skill: {} as any,
          },
        } as any)

        expect(askSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            permission: "doom_loop",
            patterns: ["skill"],
          }),
        )
      } finally {
        askSpy.mockRestore()
        llmSpy.mockRestore()
      }
    },
  })
})

test("detects doom loop across assistant attempts for same parent user", async () => {
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

      const now = Date.now()
      const userID = Identifier.ascending("message")
      await Session.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-4" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: "seed",
      })

      for (const n of [1, 2]) {
        const previous = Identifier.ascending("message")
        await Session.updateMessage({
          id: previous,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          modelID: "gpt-4",
          providerID: "openai",
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now + n, completed: now + n },
          finish: "tool-calls",
        } as MessageV2.Assistant)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: previous,
          type: "tool",
          tool: "skill",
          callID: `call_prev_${n}`,
          state: {
            status: "completed",
            input: { name: "systematic-debugging" },
            output: "Skill already active.",
            title: "Skill up-to-date: systematic-debugging",
            metadata: {
              name: "systematic-debugging",
              applied: false,
              status: "noop",
              reason: "same_turn",
            },
            time: {
              start: now + n,
              end: now + n,
            },
          },
        } as any)
      }

      const assistantID = Identifier.ascending("message")
      const assistant: MessageV2.Assistant = {
        id: assistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        modelID: "gpt-4",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now + 3 },
      }
      await Session.updateMessage(assistant)

      const model = { id: "test", providerID: "openai", limit: { context: 8192, output: 2048 } } as any
      const processor = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID: session.id,
        model,
        abort: new AbortController().signal,
      })

      const askSpy = spyOn(PermissionNext, "ask").mockResolvedValue(undefined)
      const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
        async function* fullStream() {
          const callID = "call_skill_3"
          yield { type: "start" }
          yield { type: "tool-input-start", id: callID, toolName: "skill" }
          yield {
            type: "tool-call",
            toolCallId: callID,
            toolName: "skill",
            input: { name: "systematic-debugging" },
          }
          yield {
            type: "tool-result",
            toolCallId: callID,
            input: { name: "systematic-debugging" },
            output: {
              title: "Skill up-to-date: systematic-debugging",
              output: "Skill already active.",
              metadata: {
                name: "systematic-debugging",
                applied: false,
                status: "noop",
                reason: "same_turn",
              },
              attachments: [],
            },
          }
          yield { type: "finish" }
        }

        return { fullStream: fullStream() } as any
      })

      try {
        await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: (await Agent.get("build")) as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {
            skill: {} as any,
          },
        } as any)

        expect(askSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            permission: "doom_loop",
            patterns: ["skill"],
          }),
        )
      } finally {
        askSpy.mockRestore()
        llmSpy.mockRestore()
      }
    },
  })
})
