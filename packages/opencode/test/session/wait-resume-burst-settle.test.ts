import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Provider } from "../../src/provider/provider"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("resume after wait coalesces a burst into a single model turn", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  await using tmp = await tmpdir({ git: true })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          title: "wait resume",
        })
        const source = await Session.create({})
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            WaitPolicy.clear(session.id)
            SessionStatus.set(session.id, { type: "idle" })
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
        agent: "build",
        model: { providerID: "dummy", modelID: "dummy" },
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: session.id,
        messageID: userID,
        type: "text",
        text: "seed",
      })

      const waitAssistantID = Identifier.ascending("message")
      await Session.updateMessage({
        id: waitAssistantID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        mode: "build",
        agent: "build",
        path: { cwd: tmp.path, root: tmp.path },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "dummy",
        providerID: "dummy",
        time: { created: now, completed: now },
        finish: "tool-calls",
      } satisfies MessageV2.Assistant)

      const callID = "call_wait"

      const since = SessionMessage.checkpoint(session.id)
      const wait = WaitPolicy.register({
        sessionID: session.id,
        messageID: waitAssistantID,
        callID,
        sources: [source.id],
        timeout: 10_000,
        mode: "all",
        since,
      })

      SessionStatus.set(session.id, {
        type: "waiting",
        sources: wait.sources,
        timeout: wait.timeout,
        mode: wait.mode,
        since: wait.since,
        time: wait.time,
      })

      const started = Promise.withResolvers<void>()
      let delayed = false
      const dummy = {
        id: "dummy",
        providerID: "dummy",
        api: {
          id: "dummy",
          url: "",
          npm: "@ai-sdk/openai-compatible",
        },
        limit: { context: 8192, output: 2048 },
      } as any

      const providerSpy = spyOn(Provider, "getModel").mockImplementation(async () => {
        if (!delayed) {
          delayed = true
          started.resolve()
          await Bun.sleep(150)
        }
        return dummy
      })

      const calls = { count: 0 }
      const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
        return {
          message: args.assistantMessage,
          compactionRequest: undefined,
          partFromToolCall: () => undefined,
          async process() {
            calls.count += 1
            args.assistantMessage.finish = "stop"
            args.assistantMessage.time.completed = Date.now()
            await Session.updateMessage(args.assistantMessage)
            return "stop"
          },
        } as any
      })

      await SessionMessage.deliver({
        from: source.id,
        to: session.id,
        text: "reply 1",
        awaitWake: true,
      })

      const run = SessionPrompt.loop(session.id)

      await started.promise

      await SessionMessage.deliver({
        from: source.id,
        to: session.id,
        text: "reply 2",
        awaitWake: true,
      })

      await run
      await Bun.sleep(900)

      expect(calls.count).toBe(1)

        processorSpy.mockRestore()
        providerSpy.mockRestore()
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
