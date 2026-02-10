import { expect, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

test("processor stops stream after wait_agent_message returns waiting", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const source = await Session.create({})

      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(source.id).catch(() => {})
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
        agent: "test",
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
        mode: "test",
        agent: "test",
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

      const callID = "call_wait"
      const llmSpy = spyOn(LLM, "stream").mockImplementation(async () => {
        async function* fullStream() {
          yield { type: "start" }
          yield { type: "tool-input-start", id: callID, toolName: "wait_agent_message" }
          yield {
            type: "tool-call",
            toolCallId: callID,
            toolName: "wait_agent_message",
            input: {
              sources: [source.id],
              timeout: 250,
              mode: "all",
              since: 0,
            },
          }
          yield {
            type: "tool-result",
            toolCallId: callID,
            input: {
              sources: [source.id],
              timeout: 250,
              mode: "all",
              since: 0,
            },
            output: {
              title: "Wait registered",
              output: "Wait registered. Stop generating.",
              metadata: {
                ok: true,
                status: "waiting",
                sources: [source.id],
                respondedSources: [],
                timedOutSources: [],
                timeout: 250,
                mode: "all",
                allReceived: false,
                since: 0,
              },
              attachments: [],
            },
          }

          yield { type: "text-start" }
          yield { type: "text-delta", text: "should not persist" }
          yield { type: "text-end" }
          yield { type: "finish" }
        }

        return { fullStream: fullStream() } as any
      })

      try {
        await processor.process({
          user: (await MessageV2.get({ sessionID: session.id, messageID: userID })).info as any,
          sessionID: session.id,
          model,
          agent: { name: "test" } as any,
          system: [],
          abort: new AbortController().signal,
          messages: [],
          tools: {},
        } as any)
      } finally {
        llmSpy.mockRestore()
      }

      const parts = await MessageV2.parts(assistantID)
      const text = parts.filter((p): p is MessageV2.TextPart => p.type === "text").map((p) => p.text)
      expect(text.some((value) => value.includes("should not persist"))).toBe(false)
    },
  })
})
