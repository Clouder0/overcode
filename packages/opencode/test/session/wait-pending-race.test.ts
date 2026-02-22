import { afterEach, expect, mock, spyOn, test } from "bun:test"

import "../../src/session/prompt"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { WaitPolicy } from "../../src/session/wait-policy"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

test("non-source agent pending does not interrupt wait and does not get stranded", async () => {
  const g = globalThis as any
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const source = await Session.create({})
        const other = await Session.create({})

        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            WaitPolicy.clear(session.id)
            SessionStatus.set(session.id, { type: "idle" })
            SessionStatus.set(source.id, { type: "idle" })
            SessionStatus.set(other.id, { type: "idle" })
            await Session.remove(other.id)
            await Session.remove(source.id)
            await Session.remove(session.id)
          },
        }

        SessionStatus.set(source.id, { type: "busy" })

        const now = Date.now()
        const seedID = Identifier.ascending("message")
        await Session.updateMessage({
          id: seedID,
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
          messageID: seedID,
          type: "text",
          text: "seed",
        })

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

        const calls = { count: 0 }
        const processorSpy = spyOn(SessionProcessor, "create").mockImplementation((args: any) => {
          return {
            message: args.assistantMessage,
            compactionRequest: undefined,
            partFromToolCall: () => undefined,
            async process() {
              calls.count += 1

              if (calls.count === 1) {
                const since = SessionMessage.nowSeq(session.id)
                const policy = WaitPolicy.register({
                  sessionID: session.id,
                  messageID: args.assistantMessage.id,
                  callID: "call_wait",
                  sources: [source.id],
                  timeout: 60_000,
                  mode: "all",
                  since,
                })

                SessionStatus.set(session.id, {
                  type: "waiting",
                  sources: policy.sources,
                  timeout: policy.timeout,
                  mode: policy.mode,
                  since: policy.since,
                  time: policy.time,
                })

                await Bun.sleep(120)

                args.assistantMessage.finish = "tool-calls"
                args.assistantMessage.time.completed = Date.now()
                await Session.updateMessage(args.assistantMessage)
                return "continue"
              }

              args.assistantMessage.finish = "stop"
              args.assistantMessage.time.completed = Date.now()
              await Session.updateMessage(args.assistantMessage)
              return "stop"
            },
          } as any
        })

        await using _restore = {
          [Symbol.asyncDispose]: async () => {
            providerSpy.mockRestore()
            processorSpy.mockRestore()
          },
        }

        const run = SessionPrompt.loop(session.id)
        await Bun.sleep(30)
        await SessionMessage.deliver({
          from: other.id,
          to: session.id,
          text: "non-source",
        })

        await run

        await Bun.sleep(80)

        const pending = SessionMessage.peekPending(session.id)
        const queued = pending.find((msg) => msg.from === other.id && msg.text === "non-source")

        expect(calls.count).toBe(1)
        expect(WaitPolicy.isWaiting(session.id)).toBe(true)
        // Non-source messages remain in the pending queue during a wait.
        // They will be persisted and processed when the wait resolves.
        expect(queued).toBeDefined()
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
