import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import { APICallError } from "ai"

import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMessage } from "../../src/session/message-routing"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionSummary } from "../../src/session/summary"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  mock.restore()
})

async function seedUser(input: { sessionID: string; text: string; created: number }) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: {
      providerID: "dummy",
      modelID: "dummy",
    },
    time: { created: input.created },
  })

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: user.id,
    type: "text",
    text: input.text,
  })

  return user
}

function finishStep(reason: "stop" | "tool-calls") {
  return {
    type: "finish-step" as const,
    finishReason: reason,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  }
}

async function* stopStream(text: string) {
  yield { type: "start" as const }
  yield { type: "text-start" as const }
  yield { type: "text-delta" as const, text }
  yield { type: "text-end" as const }
  yield finishStep("stop")
  yield { type: "finish" as const }
}

async function runScenario() {
  const g = globalThis as typeof globalThis & {
    __OPENCODE_TEST_ALLOW_LOOP__?: Set<string>
  }
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    return await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "queued inbound refresh" })
        const source = await Session.create({ title: "source" })
        allow.add(session.id)

        const state = {
          events: [] as string[],
          attempts: [] as { userID: string; messages: string }[],
          delivered: undefined as Awaited<ReturnType<typeof SessionMessage.deliver>> | undefined,
        }

        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
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

        const summarySpy = spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as any)

        const llmSpy = spyOn(LLM, "stream").mockImplementation(async (input: any) => {
          const call = state.attempts.length + 1
          state.attempts.push({
            userID: input.user.id,
            messages: JSON.stringify(input.messages ?? []),
          })
          state.events.push(`attempt-${call}`)

          if (call !== 1) {
            return {
              fullStream: stopStream(`attempt-${call}`),
            } as any
          }

          async function* staleAttempt() {
            yield { type: "start" as const }
            yield { type: "tool-input-start" as const, id: "call_one", toolName: "bash" }
            state.events.push("tool-1")
            yield {
              type: "tool-call" as const,
              toolCallId: "call_one",
              toolName: "bash",
              input: { command: "pwd" },
            }
            yield {
              type: "tool-result" as const,
              toolCallId: "call_one",
              input: { command: "pwd" },
              output: {
                title: "Lists current directory",
                output: "/tmp",
                metadata: {},
                attachments: [],
              },
            }

            state.delivered = await SessionMessage.deliver({
              from: source.id,
              to: session.id,
              text: "fresh inbound",
              awaitWake: true,
            })
            state.events.push("inbound")
            yield { type: "tool-input-start" as const, id: "call_two", toolName: "glob" }
            yield {
              type: "tool-call" as const,
              toolCallId: "call_two",
              toolName: "glob",
              input: { pattern: "**/*.ts" },
            }
            yield {
              type: "tool-result" as const,
              toolCallId: "call_two",
              input: { pattern: "**/*.ts" },
              output: {
                title: "Lists TypeScript files",
                output: "a.ts\nb.ts",
                metadata: {},
                attachments: [],
              },
            }
            yield finishStep("tool-calls")
            yield { type: "finish" as const }
          }

          return {
            fullStream: staleAttempt(),
          } as any
        })

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            llmSpy.mockRestore()
            summarySpy.mockRestore()
            providerSpy.mockRestore()
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
          },
        }

        const user = await seedUser({
          sessionID: session.id,
          text: "run",
          created: Date.now(),
        })

        await SessionPrompt.loop(session.id)

        const messages = await Session.messages({ sessionID: session.id })
        const assistants = messages.filter((msg) => msg.info.role === "assistant")

        return {
          user,
          events: state.events,
          attempts: state.attempts,
          delivered: state.delivered,
          hasSecondTool: assistants.some((msg) =>
            msg.parts.some((part) => part.type === "tool" && part.tool === "glob"),
          ),
          errorCount: assistants.filter((msg) => (msg.info as MessageV2.Assistant).error).length,
        }
      },
    })
  } finally {
    if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
    if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
  }
}

describe("session.prompt queued inbound refresh", () => {
  test("relevant inbound during an active turn stops before a second tool decision", async () => {
    const result = await runScenario()
    expect(result.delivered).toBeDefined()
    expect(result.hasSecondTool).toBe(false)
    expect(result.errorCount).toBe(0)
  })

  test("next prompt attempt rebuilds with queued inbound before later tool decisions", async () => {
    const result = await runScenario()
    expect(result.delivered).toBeDefined()

    const delivered = result.delivered
    const attempt = result.attempts.slice(1).find((attempt) => attempt.messages.includes("fresh inbound"))

    expect(attempt).toBeDefined()
    if (!delivered || !attempt) return

    expect(result.hasSecondTool).toBe(false)
  })
})

test("retryable errors yield back before reusing stale stream input", async () => {
  const g = globalThis as typeof globalThis & {
    __OPENCODE_TEST_ALLOW_LOOP__?: Set<string>
  }
  const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
  const allow = new Set<string>()
  g.__OPENCODE_TEST_ALLOW_LOOP__ = allow

  try {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "queued inbound refresh retry" })
        const source = await Session.create({ title: "source" })
        allow.add(session.id)

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            await Session.remove(source.id).catch(() => {})
            await Session.remove(session.id).catch(() => {})
          },
        }

        const text = "fresh inbound"
        const state = {
          delivered: undefined as Awaited<ReturnType<typeof SessionMessage.deliver>> | undefined,
          attempts: [] as { userID: string; messages: string }[],
        }

        spyOn(Provider, "getModel").mockResolvedValue({
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

        const retry = new APICallError({
          message: "Too Many Requests",
          url: "https://example.invalid",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: {},
          responseBody: "{}",
          isRetryable: true,
        })

        spyOn(LLM, "stream").mockImplementation(async (input) => {
          state.attempts.push({
            userID: input.user.id,
            messages: JSON.stringify(input.messages ?? []),
          })

          if (state.attempts.length === 1) {
            state.delivered = await SessionMessage.deliver({
              from: source.id,
              to: session.id,
              text,
              awaitWake: true,
            })
            throw retry
          }

          return {
            fullStream: stopStream(`attempt-${state.attempts.length}`),
          } as any
        })

        await seedUser({
          sessionID: session.id,
          text: "seed",
          created: Date.now(),
        })

        await SessionPrompt.loop(session.id)

        expect(state.delivered).toBeDefined()
        const delivered = state.delivered
        const attempt = state.attempts.slice(1).find((attempt) => attempt.messages.includes(text))

        expect(attempt).toBeDefined()
        if (!delivered || !attempt) return
      },
    })
  } finally {
    if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
    if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
  }
})
