import fs from "node:fs/promises"
import path from "node:path"
import { expect, spyOn, test } from "bun:test"

import { Agent } from "../../src/agent/agent"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { tmpdir } from "../fixture/fixture"

test("SessionPrompt.loop runs in session.directory when called from another directory", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__

  try {
    await using tmp = await tmpdir({ git: true })
    const root = tmp.path
    const sub = path.join(root, "subdir")
    await fs.mkdir(sub, { recursive: true })

    await Instance.provide({
      directory: sub,
      fn: async () => {
        const session = await Session.create({})
        const allow = new Set<string>([session.id])
        g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

        const now = Date.now()
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: now },
          agent: await Agent.defaultAgent(),
          model: { providerID: "dummy", modelID: "dummy" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text: "hi",
        })

        const modelSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: { id: "dummy", url: "", npm: "@ai-sdk/openai-compatible" },
          limit: { context: 8192, output: 2048 },
        } as any)

        let captured: string | undefined
        const procSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          captured = Instance.directory
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

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            modelSpy.mockRestore()
            procSpy.mockRestore()
            await Session.remove(session.id)
          },
        }

        await Instance.provide({
          directory: root,
          fn: async () => {
            await SessionPrompt.loop(session.id)
          },
        })

        expect(captured).toBe(sub)
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
