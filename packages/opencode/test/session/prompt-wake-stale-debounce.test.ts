import { afterEach, expect, mock, spyOn, test } from "bun:test"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("stale debounced wake is ignored after direct loop start", async () => {
  const g = globalThis as typeof globalThis & {
    __OPENCODE_TEST_ALLOW_LOOP__?: Set<string>
  }
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const delay = timeout === 75 ? 300 : timeout
    return originalSetTimeout(handler, delay, ...args)
  }) as typeof setTimeout

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
          },
        }

        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
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

        const model = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          modelID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          limit: { context: 8192, output: 2048 },
        } as any)

        const turns = { count: 0 }
        const processor = spyOn(SessionProcessor, "create").mockImplementation((args) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process() {
              turns.count += 1
              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        const loop = spyOn(SessionPrompt, "loop")

        await SessionMessage.deliver({
          from: source.id,
          to: session.id,
          text: "hello",
          awaitWake: true,
        })

        await SessionPrompt.loop(session.id)
        await Bun.sleep(450)

        const loops = loop.mock.calls.filter((args) => args[0] === session.id).length
        expect(loops).toBe(1)
        expect(turns.count).toBe(1)

        loop.mockRestore()
        processor.mockRestore()
        model.mockRestore()
      },
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout

    if (prev === undefined) {
      delete g.__OPENCODE_TEST_ALLOW_LOOP__
    }

    if (prev !== undefined) {
      g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
    }
  }
})
