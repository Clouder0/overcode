import { expect, test } from "bun:test"
import { Log } from "../../src/util/log"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

test("session.prompt omits orphan thinking-only assistant parts on continue", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id)
        },
      }

      const now = Date.now()

      const user1 = Identifier.ascending("message")
      await Session.updateMessage({
        id: user1,
        sessionID: session.id,
        role: "user",
        time: { created: now },
        agent: "test",
        model: { providerID: "openai", modelID: "gpt-5" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: user1,
        type: "text",
        text: "seed",
      })

      const assistant1 = Identifier.ascending("message")
      await Session.updateMessage({
        id: assistant1,
        sessionID: session.id,
        role: "assistant",
        time: { created: now },
        parentID: user1,
        modelID: "gpt-5",
        providerID: "openai",
        mode: "test",
        agent: "test",
        path: {
          cwd: tmp.path,
          root: tmp.path,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      })

      const reasoningID = Identifier.ascending("part")
      await Session.updatePart({
        id: reasoningID,
        sessionID: session.id,
        messageID: assistant1,
        type: "reasoning",
        text: "thinking...",
        metadata: { hello: "world" },
        time: { start: now },
      })

      const user2 = Identifier.ascending("message")
      await Session.updateMessage({
        id: user2,
        sessionID: session.id,
        role: "user",
        time: { created: now + 1 },
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-opus" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: user2,
        type: "text",
        text: "continue",
      })

      const orphan = await MessageV2.get({
        sessionID: session.id,
        messageID: assistant1,
      })

      const result = await SessionPrompt.omitOrphanThinking({
        sessionID: session.id,
        assistant: orphan,
        continuedAtMessageID: user2,
      })

      expect(result.omitted).toBe(true)

      const parts = await MessageV2.parts(assistant1)
      const reasoning = parts.find((p) => p.id === reasoningID)
      expect(reasoning).toBeDefined()

      if (!reasoning || reasoning.type !== "reasoning") {
        throw new Error("expected reasoning part")
      }

      expect(reasoning.ignored).toBe(true)

      const meta = reasoning.metadata
      const opencode = meta && typeof meta === "object" ? (meta as { opencode?: unknown }).opencode : undefined
      const data = opencode && typeof opencode === "object" ? (opencode as Record<string, unknown>) : undefined

      expect(data?.reason).toBe("interrupted")
      expect(data?.continuedAtMessageID).toBe(user2)

      const history = [
        await MessageV2.get({ sessionID: session.id, messageID: user1 }),
        await MessageV2.get({ sessionID: session.id, messageID: assistant1 }),
        await MessageV2.get({ sessionID: session.id, messageID: user2 }),
      ]

      const prompt = MessageV2.toModelMessages(
        history,
        {
          providerID: "openai",
          api: {
            id: "gpt-5",
            npm: "@ai-sdk/openai",
            url: "https://example.com",
          },
        } as any,
      )
      expect(prompt.some((m) => m.role === "assistant")).toBe(false)
    },
  })
})

test("session.prompt does not omit assistant messages with output", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      await using _cleanup = {
        [Symbol.asyncDispose]: async () => {
          await Session.remove(session.id)
        },
      }

      const now = Date.now()

      const user1 = Identifier.ascending("message")
      await Session.updateMessage({
        id: user1,
        sessionID: session.id,
        role: "user",
        time: { created: now },
        agent: "test",
        model: { providerID: "openai", modelID: "gpt-5" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: user1,
        type: "text",
        text: "seed",
      })

      const assistant1 = Identifier.ascending("message")
      await Session.updateMessage({
        id: assistant1,
        sessionID: session.id,
        role: "assistant",
        time: { created: now },
        parentID: user1,
        modelID: "gpt-5",
        providerID: "openai",
        mode: "test",
        agent: "test",
        path: {
          cwd: tmp.path,
          root: tmp.path,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      })

      const reasoningID = Identifier.ascending("part")
      await Session.updatePart({
        id: reasoningID,
        sessionID: session.id,
        messageID: assistant1,
        type: "reasoning",
        text: "thinking...",
        time: { start: now },
      })

      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: assistant1,
        type: "text",
        text: "partial output",
      })

      const user2 = Identifier.ascending("message")
      await Session.updateMessage({
        id: user2,
        sessionID: session.id,
        role: "user",
        time: { created: now + 1 },
        agent: "test",
        model: { providerID: "anthropic", modelID: "claude-opus" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: user2,
        type: "text",
        text: "continue",
      })

      const msg = await MessageV2.get({
        sessionID: session.id,
        messageID: assistant1,
      })

      const result = await SessionPrompt.omitOrphanThinking({
        sessionID: session.id,
        assistant: msg,
        continuedAtMessageID: user2,
      })

      expect(result.omitted).toBe(false)

      const parts = await MessageV2.parts(assistant1)
      const reasoning = parts.find((p) => p.id === reasoningID)
      expect(reasoning).toBeDefined()

      if (!reasoning || reasoning.type !== "reasoning") {
        throw new Error("expected reasoning part")
      }

      expect(reasoning.ignored).not.toBe(true)
    },
  })
})
