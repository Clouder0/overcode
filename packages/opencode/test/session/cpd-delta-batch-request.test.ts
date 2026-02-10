import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config/config"
import { Provider } from "../../src/provider/provider"
import { SessionCPD } from "../../src/session/cpd"

Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

async function seedUser(input: { sessionID: string; text: string; created: number }) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: { providerID: "dummy", modelID: "dummy" },
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

async function seedReply(input: { sessionID: string; parentID: string; created: number; directory: string }) {
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: input.sessionID,
    parentID: input.parentID,
    modelID: "dummy",
    providerID: "dummy",
    mode: "build",
    agent: "build",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: input.created, completed: input.created },
    finish: "end_turn",
  } as any)

  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: assistant.id,
    type: "text",
    text: "done",
  })

  return assistant
}

describe("session.prompt CPD batched tail request", () => {
  test("cpd update tail request reflects batched queued user text", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          // Force maintenance and CPD update path.
          limit: { context: 256, output: 200 },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const answered = await seedUser({
          sessionID: session.id,
          text: "already answered",
          created: now,
        })
        await seedReply({
          sessionID: session.id,
          parentID: answered.id,
          created: now + 1,
          directory: tmp.path,
        })

        await seedUser({
          sessionID: session.id,
          text: `anchor-cpd-request\n${"a".repeat(4096)}`,
          created: now + 2,
        })
        await seedUser({
          sessionID: session.id,
          text: `queued-cpd-request\n${"b".repeat(4096)}`,
          created: now + 3,
        })

        let capturedRequest: string | undefined
        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async (input: any) => {
          capturedRequest = input?.tail?.request
          return { text: "cpd", rctx: false }
        })

        await SessionPrompt.loop(session.id)

        cpdSpy.mockRestore()

        expect(capturedRequest).toBeDefined()
        expect(capturedRequest).toContain("anchor-cpd-request")
        expect(capturedRequest).toContain("queued-cpd-request")
      },
    })
  })

  test("cpd upto remains at prefix before oldest pending user", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cfgSpy = spyOn(Config, "get").mockResolvedValue({ compaction: { auto: true }, experimental: {} } as any)
        const providerSpy = spyOn(Provider, "getModel").mockResolvedValue({
          id: "dummy",
          providerID: "dummy",
          api: {
            id: "dummy",
            url: "",
            npm: "@ai-sdk/openai-compatible",
          },
          // Force maintenance and CPD update path.
          limit: { context: 256, output: 200 },
        } as any)

        const session = await Session.create({})

        const g = globalThis as any
        const prev = g.__OPENCODE_TEST_ALLOW_LOOP__
        g.__OPENCODE_TEST_ALLOW_LOOP__ = new Set([session.id])

        await using _cleanup = {
          [Symbol.asyncDispose]: async () => {
            cfgSpy.mockRestore()
            providerSpy.mockRestore()
            await Session.remove(session.id)
            if (prev === undefined) delete g.__OPENCODE_TEST_ALLOW_LOOP__
            if (prev !== undefined) g.__OPENCODE_TEST_ALLOW_LOOP__ = prev
          },
        }

        const now = Date.now()
        const answered = await seedUser({
          sessionID: session.id,
          text: "already answered",
          created: now,
        })
        await seedReply({
          sessionID: session.id,
          parentID: answered.id,
          created: now + 1,
          directory: tmp.path,
        })

        const anchor = await seedUser({
          sessionID: session.id,
          text: `anchor\n${"x".repeat(4096)}`,
          created: now + 2,
        })
        await seedUser({
          sessionID: session.id,
          text: `batched\n${"y".repeat(4096)}`,
          created: now + 3,
        })

        const cpdSpy = spyOn(SessionCPD, "update").mockImplementation(async () => {
          return { text: "cpd", rctx: false }
        })

        await SessionPrompt.loop(session.id)

        cpdSpy.mockRestore()

        const cpd = await SessionCPD.get(session.id)
        expect(cpd?.upto).toBe(answered.id)
        expect(cpd?.upto).not.toBe(anchor.id)
      },
    })
  })
})
